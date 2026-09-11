import { useCallback, useEffect, useRef, useState } from "react";
import { browserSessionHeaders, setBrowserSessionKey } from "../api";

interface Props {
  // Base path of the CDP bridge, e.g. /api/auth/cookie/<int>/cdp. The client
  // appends /attach, /events, /commands and /detach. No secrets in the URL —
  // every request carries the portal bearer as an Authorization header.
  cdpProxyUrl: string;
  // Width of the rendered view (height keeps aspect ratio from chromium frames).
  width: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

// Input events are coalesced into one POST per frame instead of one request
// per mousemove.
const FLUSH_MS = 12;
const MAX_RECONNECTS = 3;

/**
 * Render a live screencast of the server-side Chromium and forward mouse +
 * keyboard input back to it so the user can complete a login flow on a remote
 * browser without exposing it directly.
 *
 * Transport is plain HTTP: chromium's messages arrive on an SSE stream, ours
 * go back as batched POSTs. Chromium itself still speaks CDP over a socket,
 * but that hop is entirely server-side (see server/src/auth/cdp-bridge.ts).
 */
export default function CdpScreencast({ cdpProxyUrl, width }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  // The per-user routing key from /attach. Held here only to know whether we
  // are attached; the value itself lives in the api module so every other
  // browser-touching call carries it too.
  const keyRef = useRef<string | null>(null);
  const cmdIdRef = useRef(1);
  const queueRef = useRef<CdpMessage[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Set per connection attempt: abandons the current stream so run() re-attaches.
  const channelLostRef = useRef<(() => void) | null>(null);
  // Distinguishes "never worked" from "worked, then ended" for the error text.
  const everLiveRef = useRef(false);
  const remoteSizeRef = useRef({ width: 0, height: 0 });
  const [status, setStatus] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  // ─── client → chromium ──────────────────────────────────────────────────

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const batch = queueRef.current;
    if (!keyRef.current || batch.length === 0) return;
    queueRef.current = [];
    // The first of these to reach the server is what starts chromium, on the
    // replica the routing key sends it to.
    void fetch(`${cdpProxyUrl}/commands`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
        ...browserSessionHeaders(),
      },
      body: JSON.stringify(batch),
    })
      .then((res) => {
        // The session went away under us (reaped, or its replica restarted),
        // or a misrouted request reached a replica that does not hold it.
        // Dropping this on the floor is the bad outcome: frames keep arriving,
        // so the view looks live while input goes nowhere. Give the stream up
        // instead and let the retry loop re-attach.
        if (res.status === 404 || res.status === 409) channelLostRef.current?.();
      })
      .catch(() => undefined);
  }, [cdpProxyUrl]);

  const send = useCallback(
    (method: string, params: Record<string, unknown> = {}) => {
      // A mouseMoved only matters at its latest position — drop the one it
      // supersedes rather than replaying the whole path through chromium.
      const queue = queueRef.current;
      if (
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseMoved" &&
        queue.length > 0
      ) {
        const last = queue[queue.length - 1];
        if (last.method === "Input.dispatchMouseEvent" && last.params?.type === "mouseMoved") {
          queue.pop();
        }
      }
      queue.push({ id: cmdIdRef.current++, method, params });
      if (queue.length >= 48) {
        if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
        flush();
        return;
      }
      if (!flushTimerRef.current) flushTimerRef.current = setTimeout(flush, FLUSH_MS);
    },
    [flush]
  );

  // ─── chromium → client ──────────────────────────────────────────────────

  useEffect(() => {
    const abort = new AbortController();
    let cancelled = false;
    let attempt = 0;

    function drawFrame(b64: string) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const img = new Image();
      img.onload = () => {
        if (canvas.width !== img.width) canvas.width = img.width;
        if (canvas.height !== img.height) canvas.height = img.height;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.drawImage(img, 0, 0);
      };
      img.src = `data:image/jpeg;base64,${b64}`;
    }

    function onReady() {
      everLiveRef.current = true;
      setStatus("live");
      setError(null);
      send("Page.enable");
      send("Runtime.enable");
      send("Page.startScreencast", {
        format: "jpeg",
        quality: 70,
        maxWidth: 1280,
        maxHeight: 900,
        everyNthFrame: 1,
      });
    }

    function onCdp(raw: string) {
      let msg: CdpMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.method !== "Page.screencastFrame") return;
      const params = msg.params as
        | {
            data: string;
            metadata?: { deviceWidth?: number; deviceHeight?: number };
            sessionId: number;
          }
        | undefined;
      if (!params) return;
      if (params.metadata?.deviceWidth) {
        remoteSizeRef.current = {
          width: params.metadata.deviceWidth,
          height: params.metadata.deviceHeight ?? remoteSizeRef.current.height,
        };
      }
      drawFrame(params.data);
      send("Page.screencastFrameAck", { sessionId: params.sessionId });
    }

    async function connect(): Promise<void> {
      // One controller per attempt, chained to the component's: unmounting
      // stops everything, while a lost channel only ends this attempt.
      const attemptAbort = new AbortController();
      let lost = false;
      const chain = () => attemptAbort.abort(new Error("cancelled"));
      abort.signal.addEventListener("abort", chain);
      // Before the stream exists, losing the channel means cancelling the
      // request in flight. Once it exists, the reader is cancelled instead:
      // a body read already in progress does not observe a later abort in
      // every runtime, and this is the path that actually matters.
      channelLostRef.current = () => {
        lost = true;
        attemptAbort.abort(new Error("channel lost"));
      };
      try {
        // 1. Attach: mints this user's routing key. It starts nothing — it is
        // the one request that cannot be routed yet, so it must not be the one
        // that pins a browser to a replica.
        const attached = await fetch(`${cdpProxyUrl}/attach`, {
          method: "POST",
          headers: authHeader(),
          signal: attemptAbort.signal,
        });
        if (attached.status === 401 || attached.status === 403) {
          // A 401 here after the view has already been live is the session
          // ending, not a credential problem — say the true thing.
          throw new FatalError(everLiveRef.current ? "Session ended" : "Unauthorized");
        }
        if (!attached.ok) throw new Error(`attach failed (${attached.status})`);
        const { sessionKey } = (await attached.json()) as { sessionKey: string };
        setBrowserSessionKey(sessionKey);
        keyRef.current = sessionKey;

        // 2. Events: an SSE stream read through fetch rather than EventSource,
        // which cannot send an Authorization header — nor the routing key.
        const stream = await fetch(`${cdpProxyUrl}/events`, {
          headers: {
            Accept: "text/event-stream",
            ...authHeader(),
            ...browserSessionHeaders(),
          },
          signal: attemptAbort.signal,
        });
        if (stream.status === 401 || stream.status === 403) {
          throw new FatalError(everLiveRef.current ? "Session ended" : "Unauthorized");
        }
        if (!stream.ok || !stream.body) throw new Error(`stream failed (${stream.status})`);

        const reader = stream.body.getReader();
        channelLostRef.current = () => {
          lost = true;
          void reader.cancel();
        };
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          // SSE frames are separated by a blank line; a partial tail stays in
          // the buffer until the rest of it arrives.
          let split = buffer.indexOf("\n\n");
          while (split !== -1) {
            const frame = buffer.slice(0, split);
            buffer = buffer.slice(split + 2);
            const parsed = parseSseFrame(frame);
            if (parsed?.event === "ready") onReady();
            else if (parsed?.event === "cdp") onCdp(parsed.data);
            else if (parsed?.event === "closed") return;
            split = buffer.indexOf("\n\n");
          }
        }
        // The stream ending because we cancelled it is not the session ending:
        // make run() retry instead of reporting a clean close.
        if (lost) throw new Error("channel lost");
      } finally {
        abort.signal.removeEventListener("abort", chain);
        channelLostRef.current = null;
      }
    }

    async function run() {
      while (!cancelled) {
        try {
          await connect();
          if (cancelled) return;
          // Stream ended cleanly: the session is gone, not a transport blip.
          setStatus("closed");
          return;
        } catch (e) {
          if (cancelled || abort.signal.aborted) return;
          keyRef.current = null;
          if (e instanceof FatalError) {
            setStatus("error");
            setError(e.message);
            return;
          }
          if (++attempt > MAX_RECONNECTS) {
            setStatus("error");
            setError(e instanceof Error ? e.message : "Connection lost");
            return;
          }
          setStatus("connecting");
          await sleep(500 * attempt);
        }
      }
    }

    void run();

    return () => {
      cancelled = true;
      const attached = keyRef.current !== null;
      keyRef.current = null;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      queueRef.current = [];
      abort.abort();
      if (attached) {
        // Bodyless POST — no Content-Type, or Fastify rejects it with
        // FST_ERR_CTP_EMPTY_JSON_BODY. keepalive lets it outlive the unload.
        void fetch(`${cdpProxyUrl}/detach`, {
          method: "POST",
          headers: { ...authHeader(), ...browserSessionHeaders() },
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [cdpProxyUrl, send]);

  // Translate a DOM event on the canvas into chromium coordinates.
  function canvasToRemote(e: React.MouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * canvas.width;
    const y = ((e.clientY - rect.top) / rect.height) * canvas.height;
    return { x: Math.round(x), y: Math.round(y) };
  }

  function dispatchMouse(
    type: "mousePressed" | "mouseReleased" | "mouseMoved",
    e: React.MouseEvent<HTMLCanvasElement>
  ) {
    const { x, y } = canvasToRemote(e);
    const buttonMap: Record<number, string> = { 0: "left", 1: "middle", 2: "right" };
    const button = buttonMap[e.button] ?? "none";
    send("Input.dispatchMouseEvent", {
      type,
      x,
      y,
      button: type === "mouseMoved" ? "none" : button,
      buttons: e.buttons,
      clickCount: type === "mousePressed" ? e.detail || 1 : 0,
      modifiers: modifierMaskFromEvent(e),
    });
  }

  function dispatchScroll(e: React.WheelEvent<HTMLCanvasElement>) {
    const { x, y } = canvasToRemote(e as unknown as React.MouseEvent<HTMLCanvasElement>);
    send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX: -e.deltaX,
      deltaY: -e.deltaY,
      modifiers: modifierMaskFromEvent(e),
    });
  }

  function dispatchKey(e: React.KeyboardEvent<HTMLCanvasElement>, type: "keyDown" | "keyUp") {
    e.preventDefault();
    e.stopPropagation();
    const isChar = type === "keyDown" && e.key.length === 1;
    send("Input.dispatchKeyEvent", {
      type: isChar ? "char" : type,
      text: isChar ? e.key : undefined,
      key: e.key,
      code: e.code,
      windowsVirtualKeyCode: e.keyCode,
      modifiers: modifierMaskFromEvent(e),
    });
    // Also send the keyDown so chromium fires both pieces for printable keys.
    if (isChar) {
      send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: e.key,
        code: e.code,
        windowsVirtualKeyCode: e.keyCode,
        modifiers: modifierMaskFromEvent(e),
      });
    }
  }

  return (
    <div style={{ position: "relative", width, background: "#000" }}>
      {status !== "live" && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#fff",
            font: "12px monospace",
            background: "rgba(0,0,0,0.6)",
            zIndex: 1,
          }}
        >
          {status}
          {error ? `: ${error}` : ""}
        </div>
      )}
      <canvas
        ref={canvasRef}
        tabIndex={0}
        style={{ width: "100%", display: "block", outline: "none", cursor: "default" }}
        onMouseDown={(e) => dispatchMouse("mousePressed", e)}
        onMouseUp={(e) => dispatchMouse("mouseReleased", e)}
        onMouseMove={(e) => dispatchMouse("mouseMoved", e)}
        onWheel={dispatchScroll}
        onKeyDown={(e) => dispatchKey(e, "keyDown")}
        onKeyUp={(e) => dispatchKey(e, "keyUp")}
        onContextMenu={(e) => e.preventDefault()}
      />
    </div>
  );
}

// An auth failure is not worth retrying — reconnecting can't fix it.
class FatalError extends Error {}

function authHeader(): Record<string, string> {
  const token = localStorage.getItem("awb_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Parse one SSE frame into its event name and (possibly multi-line) data.
// Comment lines (": keepalive") carry no event and are ignored.
export function parseSseFrame(frame: string): { event: string; data: string } | null {
  let event = "";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (line.startsWith(":") || line === "") continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
  }
  if (!event) return null;
  return { event, data: data.join("\n") };
}

function modifierMaskFromEvent(
  e: React.MouseEvent | React.KeyboardEvent | React.WheelEvent
): number {
  // CDP modifier mask: 1=alt, 2=ctrl, 4=meta, 8=shift
  let m = 0;
  if (e.altKey) m |= 1;
  if (e.ctrlKey) m |= 2;
  if (e.metaKey) m |= 4;
  if (e.shiftKey) m |= 8;
  return m;
}
