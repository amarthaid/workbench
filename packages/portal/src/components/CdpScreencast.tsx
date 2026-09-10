import { useCallback, useEffect, useRef, useState } from "react";

interface Props {
  // Base path of the CDP bridge, e.g. /api/auth/cookie/<int>/cdp. The client
  // appends /attach, /events, /commands and /detach. No secrets in the URL —
  // every request carries the portal bearer as an Authorization header.
  cdpProxyUrl: string;
  sessionId: string;
  cdpToken: string;
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
export default function CdpScreencast({ cdpProxyUrl, sessionId, cdpToken, width }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const channelRef = useRef<string | null>(null);
  const cmdIdRef = useRef(1);
  const queueRef = useRef<CdpMessage[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remoteSizeRef = useRef({ width: 0, height: 0 });
  const [status, setStatus] = useState<"connecting" | "live" | "closed" | "error">("connecting");
  const [error, setError] = useState<string | null>(null);

  // ─── client → chromium ──────────────────────────────────────────────────

  const flush = useCallback(() => {
    flushTimerRef.current = null;
    const channel = channelRef.current;
    const batch = queueRef.current;
    if (!channel || batch.length === 0) return;
    queueRef.current = [];
    void fetch(`${cdpProxyUrl}/commands?channel=${encodeURIComponent(channel)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...authHeader(),
      },
      body: JSON.stringify(batch),
    }).catch(() => undefined);
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
      // 1. Attach: proves who we are and dials chromium. The bearer goes in a
      // header — the reason this is a POST and not a socket handshake.
      const attached = await fetch(`${cdpProxyUrl}/attach`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeader() },
        body: JSON.stringify({ sessionId, cdpToken }),
        signal: abort.signal,
      });
      if (attached.status === 401 || attached.status === 403) throw new FatalError("Unauthorized");
      if (!attached.ok) throw new Error(`attach failed (${attached.status})`);
      const { channelId } = (await attached.json()) as { channelId: string };
      channelRef.current = channelId;

      // 2. Events: an SSE stream read through fetch rather than EventSource,
      // which cannot send an Authorization header.
      const stream = await fetch(
        `${cdpProxyUrl}/events?channel=${encodeURIComponent(channelId)}`,
        { headers: { Accept: "text/event-stream", ...authHeader() }, signal: abort.signal }
      );
      if (stream.status === 401 || stream.status === 403) throw new FatalError("Unauthorized");
      if (!stream.ok || !stream.body) throw new Error(`stream failed (${stream.status})`);

      const reader = stream.body.getReader();
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
          channelRef.current = null;
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
      const channel = channelRef.current;
      channelRef.current = null;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      queueRef.current = [];
      abort.abort();
      if (channel) {
        // Bodyless POST — no Content-Type, or Fastify rejects it with
        // FST_ERR_CTP_EMPTY_JSON_BODY. keepalive lets it outlive the unload.
        void fetch(`${cdpProxyUrl}/detach?channel=${encodeURIComponent(channel)}`, {
          method: "POST",
          headers: authHeader(),
          keepalive: true,
        }).catch(() => undefined);
      }
    };
  }, [cdpProxyUrl, sessionId, cdpToken, send]);

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
