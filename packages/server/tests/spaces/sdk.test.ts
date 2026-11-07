import { describe, it, expect, afterEach, vi } from "vitest";
import { MessageChannel, type MessagePort } from "node:worker_threads";
import { SDK_SOURCE } from "../../src/spaces/sdk";

// Run the SDK against a minimal window double: the handshake only needs
// window.parent and message listeners, and the port is a real MessageChannel.
type Listener = (e: { source: unknown; data: unknown; ports?: MessagePort[] }) => void;

const open: MessagePort[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const p of open.splice(0)) p.close();
});

function load() {
  const listeners = new Set<Listener>();
  const parent = { name: "shell" };
  const win: any = {
    parent,
    addEventListener: (_t: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_t: string, fn: Listener) => listeners.delete(fn),
  };
  new Function("window", SDK_SOURCE)(win);
  const dispatch = (ev: { source: unknown; data: unknown; ports?: MessagePort[] }) => {
    for (const fn of Array.from(listeners)) fn(ev);
  };
  return { win, parent, dispatch, listeners };
}

/** A shell end that records requests and answers with `reply`. */
function shell(reply: (msg: any) => any) {
  const ch = new MessageChannel();
  open.push(ch.port1, ch.port2);
  const seen: any[] = [];
  ch.port1.on("message", (msg: any) => {
    seen.push(msg);
    const r = reply(msg);
    if (r !== undefined) ch.port1.postMessage({ __wb: 1, id: msg.id, ...r });
  });
  return { port2: ch.port2, seen };
}

const handshake = (parent: unknown, port: MessagePort) => ({ source: parent, data: { __wb: 1, type: "port" }, ports: [port] });

describe("Space SDK", () => {
  it("defines a frozen window.workbench with the spec API", () => {
    const { win } = load();
    expect(typeof win.workbench.call).toBe("function");
    expect(typeof win.workbench.me).toBe("function");
    for (const k of ["get", "set", "delete", "keys"]) expect(typeof win.workbench.store[k]).toBe("function");
    expect(Object.isFrozen(win.workbench)).toBe(true);
  });

  it("queues calls made before the port and flushes them in order", async () => {
    const { win, parent, dispatch } = load();
    const s = shell((m) => ({ ok: true, result: { echo: m.payload } }));
    const p1 = win.workbench.call("github", "list_prs", { owner: "acme" });
    const p2 = win.workbench.me();
    dispatch(handshake(parent, s.port2));
    expect(await p1).toEqual({ echo: { integration: "github", tool: "list_prs", args: { owner: "acme" } } });
    expect(await p2).toEqual({ echo: {} });
    expect(s.seen.map((m) => m.type)).toEqual(["call", "me"]);
    expect(s.seen[0].id).toBeLessThan(s.seen[1].id);
  });

  it("accepts the port only from window.parent, and only once", async () => {
    const { win, parent, dispatch, listeners } = load();
    const rogue = shell(() => ({ ok: true, result: "rogue" }));
    dispatch(handshake({ name: "not-parent" }, rogue.port2));
    dispatch({ source: parent, data: { __wb: 1, type: "nope" }, ports: [rogue.port2] });
    const real = shell(() => ({ ok: true, result: "real" }));
    dispatch(handshake(parent, real.port2));
    expect(listeners.size).toBe(0);
    const late = shell(() => ({ ok: true, result: "late" }));
    dispatch(handshake(parent, late.port2));
    expect(await win.workbench.call("acme", "list_items")).toBe("real");
    expect(rogue.seen).toHaveLength(0);
    expect(late.seen).toHaveLength(0);
  });

  it("never sends a confirmed field, whatever the caller passes", async () => {
    const { win, parent, dispatch } = load();
    const s = shell(() => ({ ok: true, result: null }));
    dispatch(handshake(parent, s.port2));
    await win.workbench.call("acme", "delete_item", { id: "1" }, { confirmed: true });
    expect(Object.keys(s.seen[0]).sort()).toEqual(["__wb", "id", "payload", "type"]);
    expect(Object.keys(s.seen[0].payload).sort()).toEqual(["args", "integration", "tool"]);
    expect(JSON.stringify(s.seen[0])).not.toContain("confirmed");
  });

  it("rejects with a WorkbenchError carrying code, message, integration, tool", async () => {
    const { win, parent, dispatch } = load();
    const s = shell(() => ({ ok: false, error: { code: "NOT_CONNECTED", message: "connect github", integration: "github" } }));
    dispatch(handshake(parent, s.port2));
    const err = await win.workbench.call("github", "list_prs").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(win.workbench.WorkbenchError);
    expect(err).toBeInstanceOf(Error);
    expect(err).toMatchObject({ name: "WorkbenchError", code: "NOT_CONNECTED", message: "connect github", integration: "github", tool: "list_prs" });
  });

  it("maps store calls onto kv.* requests", async () => {
    const { win, parent, dispatch } = load();
    const s = shell((m) => ({ ok: true, result: m.type === "kv.get" ? 42 : m.type === "kv.keys" ? ["a"] : null }));
    dispatch(handshake(parent, s.port2));
    expect(await win.workbench.store.get("a")).toBe(42);
    expect(await win.workbench.store.set("a", { v: 1 })).toBeUndefined();
    expect(await win.workbench.store.delete("a")).toBeUndefined();
    expect(await win.workbench.store.keys()).toEqual(["a"]);
    expect(s.seen.map((m) => [m.type, m.payload])).toEqual([
      ["kv.get", { key: "a" }],
      ["kv.set", { key: "a", value: { v: 1 } }],
      ["kv.delete", { key: "a" }],
      ["kv.keys", {}],
    ]);
  });

  it("rejects bad input locally with INVALID_ARGS", async () => {
    const { win } = load();
    await expect(win.workbench.call("", "x")).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(win.workbench.call("acme", "x", [1])).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(win.workbench.call("acme", "x", { f: () => 1 })).rejects.toMatchObject({ code: "INVALID_ARGS" });
    await expect(win.workbench.store.get("k".repeat(129))).rejects.toMatchObject({ code: "INVALID_ARGS" });
  });

  it("times out after 120 s with TIMEOUT, queued or sent", async () => {
    vi.useFakeTimers();
    const { win } = load();
    const p = win.workbench.call("acme", "list_items").catch((e: unknown) => e);
    vi.advanceTimersByTime(119_999);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    vi.advanceTimersByTime(1);
    expect(await p).toMatchObject({ code: "TIMEOUT", integration: "acme", tool: "list_items" });
  });
});
