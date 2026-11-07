// The shell side of the Space wire protocol. Framework-free so it can be unit
// tested against a fake frame and a real MessageChannel.
//
// Trust model (see the Spaces design, "Residual risk"): the Space's frame can
// navigate itself elsewhere and keep the same contentWindow. So the bridge
// posts exactly one message to contentWindow, on the frame's first load: a
// MessagePort. Every request is read from, and every reply written to, the
// shell's end of that channel. It never listens to window "message" events,
// so a later document in the frame can neither call nor read replies. A second
// load is treated as a navigation and stops the bridge.

import { SpaceApiError, type SpaceCallBody, type SpaceDetail, type SpaceErrorBody, type SpaceTool } from "../spaces-api";

export interface FrameLike {
  addEventListener(type: "load", listener: () => void): void;
  removeEventListener(type: "load", listener: () => void): void;
  readonly contentWindow: { postMessage(message: unknown, targetOrigin: string, transfer?: Transferable[]): void } | null;
}

export interface BridgeApi {
  call(body: SpaceCallBody): Promise<unknown>;
  kvKeys(): Promise<string[]>;
  kvGet(key: string): Promise<unknown>;
  kvSet(key: string, value: unknown): Promise<void>;
  kvDelete(key: string): Promise<void>;
}

export interface ConfirmRequest {
  /** Fully-qualified tool name. */
  tool: string;
  integration: string;
  integrationName: string;
  description?: string;
  args: unknown;
}

export interface BridgeOptions {
  frame: FrameLike;
  /** The shell's own view of the Space: the only source of a tool's effect. */
  getSpace(): SpaceDetail;
  api: BridgeApi;
  me(): Promise<{ email: string }>;
  /** Show the confirm modal. Called one at a time; resolves true on Allow. */
  confirm(request: ConfirmRequest): Promise<boolean>;
  onNotConnected?(integration: string, integrationName: string): void;
  onConsentRequired?(): void;
  onPaused?(): void;
  onNavigatedAway?(): void;
  now?(): number;
}

export interface SpaceBridge {
  dispose(): void;
}

/** More than this many confirmation requests inside the window pauses the Space. */
export const MAX_CONFIRMATIONS = 5;
export const CONFIRMATION_WINDOW_MS = 10_000;

type Reply = { __wb: 1; id: unknown; ok: true; result: unknown } | { __wb: 1; id: unknown; ok: false; error: SpaceErrorBody };

class BridgeError extends Error {
  constructor(readonly body: SpaceErrorBody) {
    super(body.message);
  }
}

function fail(code: string, message: string, extra: Partial<SpaceErrorBody> = {}): never {
  throw new BridgeError({ code, message, ...extra });
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isDestructive(tool: SpaceTool): boolean {
  if (tool.missing) return true;
  return tool.effect !== "read" && tool.effect !== "write";
}

// Same two spellings as /rest: the fully-qualified name or the bare suffix,
// always inside the integration the Space named.
export function resolveSpaceTool(space: SpaceDetail, integration: string, tool: string): SpaceTool | undefined {
  const prefix = `${integration}_`;
  const candidates = tool.startsWith(prefix) ? [tool] : [tool, `${prefix}${tool}`];
  for (const candidate of candidates) {
    const found = space.tools.find((t) => t.name === candidate && t.integration === integration);
    if (found) return found;
  }
  return undefined;
}

export function createSpaceBridge(opts: BridgeOptions): SpaceBridge {
  const now = opts.now ?? (() => Date.now());
  let loads = 0;
  let port: MessagePort | null = null;
  let disposed = false;
  let paused = false;
  let confirmTimes: number[] = [];
  let confirmChain: Promise<unknown> = Promise.resolve();

  function onLoad() {
    if (disposed) return;
    loads += 1;
    if (loads === 1) {
      const target = opts.frame.contentWindow;
      if (!target) return;
      const channel = new MessageChannel();
      port = channel.port1;
      port.onmessage = (event: MessageEvent) => {
        void handle(event.data);
      };
      // The only message ever posted to contentWindow. The Space's origin is
      // opaque, so "*" is the only target origin that reaches it.
      target.postMessage({ __wb: 1, type: "port" }, "*", [channel.port2]);
      return;
    }
    dispose();
    opts.onNavigatedAway?.();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    opts.frame.removeEventListener("load", onLoad);
    if (port) {
      port.onmessage = null;
      port.close();
      port = null;
    }
  }

  function reply(message: Reply) {
    if (disposed || !port) return;
    port.postMessage(message);
  }

  function requestConfirm(request: ConfirmRequest): Promise<boolean> {
    if (disposed || paused) return Promise.resolve(false);
    const t = now();
    confirmTimes = confirmTimes.filter((at) => t - at < CONFIRMATION_WINDOW_MS);
    confirmTimes.push(t);
    if (confirmTimes.length > MAX_CONFIRMATIONS) {
      paused = true;
      dispose();
      opts.onPaused?.();
      return Promise.resolve(false);
    }
    // One modal at a time: each request waits for the one before it.
    const result = confirmChain.then(() => (disposed ? false : opts.confirm(request))).catch(() => false);
    confirmChain = result;
    return result;
  }

  async function confirmOrDeny(tool: SpaceTool, args: unknown) {
    const allowed = await requestConfirm({
      tool: tool.name,
      integration: tool.integration,
      integrationName: tool.integrationName || tool.integration,
      ...(tool.description ? { description: tool.description } : {}),
      args,
    });
    if (!allowed) {
      fail("DENIED", paused ? "This Space was paused" : "The viewer denied this action", {
        integration: tool.integration,
        tool: tool.name,
      });
    }
  }

  async function runCall(payload: unknown): Promise<unknown> {
    if (!isObject(payload) || typeof payload.integration !== "string" || typeof payload.tool !== "string") {
      fail("INVALID_ARGS", "call needs { integration, tool, args }");
    }
    const integration = payload.integration;
    const tool = resolveSpaceTool(opts.getSpace(), integration, payload.tool);
    if (!tool) {
      fail("TOOL_NOT_DECLARED", `Tool "${payload.tool}" is not declared by this Space`, {
        integration,
        tool: payload.tool,
      });
    }
    const args = payload.args;
    // Built from scratch: nothing the Space sent besides integration, tool
    // and args reaches the server, so a Space-supplied `confirmed` never does.
    const body = (confirmed: boolean): SpaceCallBody => ({
      tool: tool.name,
      ...(args !== undefined ? { args } : {}),
      ...(confirmed ? { confirmed: true as const } : {}),
    });

    let confirmed = false;
    if (isDestructive(tool)) {
      await confirmOrDeny(tool, args);
      confirmed = true;
    }
    try {
      return await opts.api.call(body(confirmed));
    } catch (e) {
      // The shell's view was stale: the server says this one needs a yes.
      if (!confirmed && e instanceof SpaceApiError && (e.status === 428 || e.code === "CONFIRMATION_REQUIRED")) {
        await confirmOrDeny(tool, args);
        return await opts.api.call(body(true));
      }
      throw e;
    }
  }

  function keyOf(payload: unknown): string {
    if (!isObject(payload) || typeof payload.key !== "string") fail("INVALID_ARGS", "A string key is required");
    return payload.key;
  }

  async function dispatch(type: string, payload: unknown): Promise<unknown> {
    switch (type) {
      case "call":
        return runCall(payload);
      case "me":
        return opts.me();
      case "kv.get":
        return opts.api.kvGet(keyOf(payload));
      case "kv.set": {
        const key = keyOf(payload);
        const value = isObject(payload) ? payload.value : undefined;
        await opts.api.kvSet(key, value === undefined ? null : value);
        return undefined;
      }
      case "kv.delete":
        await opts.api.kvDelete(keyOf(payload));
        return undefined;
      case "kv.keys":
        return opts.api.kvKeys();
      default:
        return fail("INVALID_ARGS", `Unknown request type: ${type}`);
    }
  }

  function toErrorBody(e: unknown): SpaceErrorBody {
    if (e instanceof BridgeError) return e.body;
    if (e instanceof SpaceApiError) return e.toBody();
    return { code: "UPSTREAM_ERROR", message: e instanceof Error ? e.message : "Request failed" };
  }

  function sideEffects(error: SpaceErrorBody, type: string, payload: unknown) {
    if (error.code === "CONSENT_REQUIRED") {
      dispose();
      opts.onConsentRequired?.();
      return;
    }
    if (error.code === "NOT_CONNECTED" && type === "call") {
      const space = opts.getSpace();
      const integration =
        error.integration ?? (isObject(payload) && typeof payload.integration === "string" ? payload.integration : "");
      if (!integration) return;
      const name = space.tools.find((t) => t.integration === integration)?.integrationName || integration;
      opts.onNotConnected?.(integration, name);
    }
  }

  async function handle(data: unknown) {
    if (disposed) return;
    if (!isObject(data) || data.__wb !== 1 || typeof data.type !== "string" || !("id" in data)) return;
    const { id, type, payload } = data;
    try {
      const result = await dispatch(type, payload);
      reply({ __wb: 1, id, ok: true, result });
    } catch (e) {
      const error = toErrorBody(e);
      // Reply before side effects: a CONSENT_REQUIRED tears the port down.
      reply({ __wb: 1, id, ok: false, error });
      sideEffects(error, type, payload);
    }
  }

  opts.frame.addEventListener("load", onLoad);
  return { dispose };
}
