import { describe, it, expect, vi, afterEach } from "vitest";
import { createSpaceBridge, type BridgeOptions, type ConfirmRequest, type FrameLike, MAX_CONFIRMATIONS } from "./bridge";
import { SpaceApiError, type SpaceCallBody, type SpaceDetail } from "../spaces-api";

const SPACE: SpaceDetail = {
  name: "pr-timeline",
  title: "PR timeline",
  description: null,
  ownerEmail: "dev@example.com",
  mine: false,
  visibility: "org",
  updatedAt: 1_700_000_000_000,
  consented: true,
  appUrl: "/s/pr-timeline/app/sig/",
  tools: [
    { name: "github_list_prs", integration: "github", integrationName: "GitHub", effect: "read", connected: true },
    { name: "github_create_issue", integration: "github", integrationName: "GitHub", effect: "write", connected: true },
    { name: "github_merge_pr", integration: "github", integrationName: "GitHub", effect: "destructive", connected: true },
    { name: "github_weird", integration: "github", integrationName: "GitHub", effect: "sideways", connected: true },
    { name: "github_unlabelled", integration: "github", integrationName: "GitHub", connected: true },
    { name: "github_gone", integration: "github", integrationName: "GitHub", effect: "read", missing: true },
    { name: "bitbucket_list_prs", integration: "bitbucket", integrationName: "Bitbucket", effect: "read", connected: false },
  ],
};

const openPorts: MessagePort[] = [];

afterEach(() => {
  for (const p of openPorts.splice(0)) p.close();
});

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

function fakeFrame() {
  const listeners = new Set<() => void>();
  const contentWindow = { postMessage: vi.fn() };
  const frame: FrameLike = {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
    contentWindow,
  };
  return { frame, contentWindow, load: () => [...listeners].forEach((l) => l()) };
}

function setup(overrides: Partial<BridgeOptions> = {}) {
  const f = fakeFrame();
  const api = {
    call: vi.fn(async (_body: SpaceCallBody) => ({ prs: [1, 2] }) as unknown),
    kvKeys: vi.fn(async () => ["a", "b"]),
    kvGet: vi.fn(async () => ({ saved: true }) as unknown),
    kvSet: vi.fn(async () => undefined),
    kvDelete: vi.fn(async () => undefined),
  };
  const opts: BridgeOptions = {
    frame: f.frame,
    getSpace: () => SPACE,
    api,
    me: vi.fn(async () => ({ email: "dev@example.com" })),
    confirm: vi.fn(async () => true),
    onNotConnected: vi.fn(),
    onConsentRequired: vi.fn(),
    onPaused: vi.fn(),
    onNavigatedAway: vi.fn(),
    ...overrides,
  };
  const bridge = createSpaceBridge(opts);
  return { ...f, api, opts, bridge };
}

// The Space's end of the channel, as the SDK would use it.
function connect(contentWindow: { postMessage: ReturnType<typeof vi.fn> }) {
  const port = contentWindow.postMessage.mock.calls[0][2][0] as MessagePort;
  openPorts.push(port);
  const replies: Array<Record<string, unknown>> = [];
  const waiters = new Map<unknown, (r: Record<string, unknown>) => void>();
  port.onmessage = (e: MessageEvent) => {
    replies.push(e.data);
    waiters.get(e.data.id)?.(e.data);
  };
  let next = 0;
  function send(type: string, payload?: unknown, extra: Record<string, unknown> = {}) {
    const id = `r${++next}`;
    const reply = new Promise<Record<string, unknown>>((resolve) => waiters.set(id, resolve));
    port.postMessage({ __wb: 1, id, type, payload, ...extra });
    return { id, reply };
  }
  return { port, send, replies };
}

function started(overrides: Partial<BridgeOptions> = {}) {
  const s = setup(overrides);
  s.load();
  return { ...s, space: connect(s.contentWindow) };
}

describe("handshake", () => {
  it("posts nothing before the first load", () => {
    const { contentWindow } = setup();
    expect(contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it("posts one port message to contentWindow with target origin *", () => {
    const { contentWindow, load } = setup();
    load();
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
    const [msg, origin, transfer] = contentWindow.postMessage.mock.calls[0];
    expect(msg).toEqual({ __wb: 1, type: "port" });
    expect(origin).toBe("*");
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBeInstanceOf(MessagePort);
    openPorts.push(transfer[0]);
  });

  it("never posts to contentWindow again, however many requests are served", async () => {
    const { contentWindow, space } = started();
    await space.send("me").reply;
    await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores requests posted to the window after the handshake", async () => {
    const { contentWindow, api } = started();
    window.dispatchEvent(
      new MessageEvent("message", {
        data: { __wb: 1, id: "x", type: "call", payload: { integration: "github", tool: "list_prs" } },
        source: contentWindow as unknown as Window,
      })
    );
    await tick();
    expect(api.call).not.toHaveBeenCalled();
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
  });

  it("ignores malformed port messages", async () => {
    const { space, api } = started();
    space.port.postMessage({ id: "1", type: "call", payload: { integration: "github", tool: "list_prs" } });
    space.port.postMessage("hello");
    space.port.postMessage({ __wb: 1, type: "me" });
    await tick();
    expect(space.replies).toEqual([]);
    expect(api.call).not.toHaveBeenCalled();
  });
});

describe("second load", () => {
  it("stops the bridge and reports a navigation", async () => {
    const { load, space, api, opts } = started();
    load();
    expect(opts.onNavigatedAway).toHaveBeenCalledTimes(1);
    space.send("call", { integration: "github", tool: "list_prs" });
    await tick();
    expect(api.call).not.toHaveBeenCalled();
    expect(space.replies).toEqual([]);
  });

  it("does not hand the new document a port", () => {
    const { load, contentWindow } = started();
    load();
    load();
    expect(contentWindow.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe("call", () => {
  it("round-trips a read call through the API", async () => {
    const { space, api, opts } = started();
    const r = await space.send("call", { integration: "github", tool: "list_prs", args: { state: "open" } }).reply;
    expect(api.call).toHaveBeenCalledWith({ tool: "github_list_prs", args: { state: "open" } });
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(r).toEqual({ __wb: 1, id: "r1", ok: true, result: { prs: [1, 2] } });
  });

  it("accepts the fully-qualified tool name", async () => {
    const { space, api } = started();
    await space.send("call", { integration: "github", tool: "github_list_prs" }).reply;
    expect(api.call).toHaveBeenCalledWith({ tool: "github_list_prs" });
  });

  it("refuses a tool the Space did not declare without calling the API", async () => {
    const { space, api } = started();
    const r = await space.send("call", { integration: "github", tool: "delete_repo" }).reply;
    expect(r.ok).toBe(false);
    expect((r.error as { code: string }).code).toBe("TOOL_NOT_DECLARED");
    expect(api.call).not.toHaveBeenCalled();
  });

  it("does not resolve a tool across integrations", async () => {
    const { space, api } = started();
    const r = await space.send("call", { integration: "bitbucket", tool: "github_list_prs" }).reply;
    expect((r.error as { code: string }).code).toBe("TOOL_NOT_DECLARED");
    expect(api.call).not.toHaveBeenCalled();
  });

  it("does not confirm a write", async () => {
    const { space, api, opts } = started();
    await space.send("call", { integration: "github", tool: "create_issue", args: { title: "t" } }).reply;
    expect(opts.confirm).not.toHaveBeenCalled();
    expect(api.call).toHaveBeenCalledWith({ tool: "github_create_issue", args: { title: "t" } });
  });

  it("asks before a destructive call and sends confirmed only after Allow", async () => {
    const { space, api, opts } = started();
    const r = await space.send("call", { integration: "github", tool: "merge_pr", args: { id: 7 } }).reply;
    expect(opts.confirm).toHaveBeenCalledWith({
      tool: "github_merge_pr",
      integration: "github",
      integrationName: "GitHub",
      args: { id: 7 },
    });
    expect(api.call).toHaveBeenCalledWith({ tool: "github_merge_pr", args: { id: 7 }, confirmed: true });
    expect(r.ok).toBe(true);
  });

  it("answers DENIED and never calls the API when the viewer denies", async () => {
    const { space, api } = started({ confirm: vi.fn(async () => false) });
    const r = await space.send("call", { integration: "github", tool: "merge_pr", args: { id: 7 } }).reply;
    expect(r.ok).toBe(false);
    expect((r.error as { code: string }).code).toBe("DENIED");
    expect(api.call).not.toHaveBeenCalled();
  });

  it.each(["weird", "unlabelled", "gone"])("treats %s (unknown effect or missing) as destructive", async (tool) => {
    const { space, opts, api } = started();
    await space.send("call", { integration: "github", tool }).reply;
    expect(opts.confirm).toHaveBeenCalledTimes(1);
    expect(api.call).toHaveBeenCalledWith({ tool: `github_${tool}`, confirmed: true });
  });

  it("ignores a confirmed flag supplied by the Space", async () => {
    const { space, api, opts } = started();
    await space.send(
      "call",
      { integration: "github", tool: "list_prs", args: { a: 1 }, confirmed: true },
      { confirmed: true }
    ).reply;
    expect(api.call).toHaveBeenCalledWith({ tool: "github_list_prs", args: { a: 1 } });
    expect(api.call.mock.calls[0][0]).not.toHaveProperty("confirmed");

    const deny = vi.mocked(opts.confirm);
    deny.mockResolvedValueOnce(false);
    const r = await space.send(
      "call",
      { integration: "github", tool: "merge_pr", confirmed: true },
      { confirmed: true }
    ).reply;
    expect(deny).toHaveBeenCalledTimes(1);
    expect((r.error as { code: string }).code).toBe("DENIED");
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it("on a 428 asks the viewer, then retries with confirmed", async () => {
    const { space, api, opts } = started();
    api.call
      .mockRejectedValueOnce(new SpaceApiError(428, { code: "CONFIRMATION_REQUIRED", message: "confirm" }))
      .mockResolvedValueOnce({ done: true });
    const r = await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect(opts.confirm).toHaveBeenCalledTimes(1);
    expect(api.call.mock.calls[0][0]).toEqual({ tool: "github_list_prs" });
    expect(api.call.mock.calls[1][0]).toEqual({ tool: "github_list_prs", confirmed: true });
    expect(r).toMatchObject({ ok: true, result: { done: true } });
  });

  it("on a 428 and a Deny answers DENIED without retrying", async () => {
    const { space, api } = started({ confirm: vi.fn(async () => false) });
    api.call.mockRejectedValueOnce(new SpaceApiError(428, { code: "CONFIRMATION_REQUIRED", message: "confirm" }));
    const r = await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect((r.error as { code: string }).code).toBe("DENIED");
    expect(api.call).toHaveBeenCalledTimes(1);
  });

  it("shows one confirmation at a time", async () => {
    const resolvers: Array<(v: boolean) => void> = [];
    const confirm = vi.fn((_req: ConfirmRequest) => new Promise<boolean>((r) => resolvers.push(r)));
    const { space } = started({ confirm });
    const a = space.send("call", { integration: "github", tool: "merge_pr", args: { id: 1 } });
    const b = space.send("call", { integration: "github", tool: "merge_pr", args: { id: 2 } });
    await tick();
    expect(confirm).toHaveBeenCalledTimes(1);
    resolvers[0](true);
    await a.reply;
    await tick();
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1][0]).toMatchObject({ args: { id: 2 } });
    resolvers[1](false);
    expect(((await b.reply).error as { code: string }).code).toBe("DENIED");
  });

  it(`pauses after more than ${MAX_CONFIRMATIONS} confirmations in 10 s`, async () => {
    let t = 0;
    const { space, opts, api } = started({ now: () => (t += 1000) });
    for (let i = 0; i < MAX_CONFIRMATIONS; i++) {
      await space.send("call", { integration: "github", tool: "merge_pr" }).reply;
    }
    expect(opts.onPaused).not.toHaveBeenCalled();
    space.send("call", { integration: "github", tool: "merge_pr" });
    await tick();
    expect(opts.onPaused).toHaveBeenCalledTimes(1);
    expect(opts.confirm).toHaveBeenCalledTimes(MAX_CONFIRMATIONS);
    expect(api.call).toHaveBeenCalledTimes(MAX_CONFIRMATIONS);
  });

  it("does not pause when confirmations are spread out", async () => {
    let t = 0;
    const { space, opts } = started({ now: () => (t += 3000) });
    for (let i = 0; i < 8; i++) {
      await space.send("call", { integration: "github", tool: "merge_pr" }).reply;
    }
    expect(opts.onPaused).not.toHaveBeenCalled();
  });

  it("NOT_CONNECTED raises the connect banner and is passed to the Space", async () => {
    const { space, api, opts } = started();
    api.call.mockRejectedValueOnce(
      new SpaceApiError(409, { code: "NOT_CONNECTED", message: "not connected", integration: "bitbucket" })
    );
    const r = await space.send("call", { integration: "bitbucket", tool: "list_prs" }).reply;
    expect(r.error).toEqual({ code: "NOT_CONNECTED", message: "not connected", integration: "bitbucket" });
    expect(opts.onNotConnected).toHaveBeenCalledWith("bitbucket", "Bitbucket");
  });

  it("CONSENT_REQUIRED answers the Space, then stops the bridge", async () => {
    const { space, api, opts } = started();
    api.call.mockRejectedValueOnce(new SpaceApiError(403, { code: "CONSENT_REQUIRED", message: "consent" }));
    const r = await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect((r.error as { code: string }).code).toBe("CONSENT_REQUIRED");
    expect(opts.onConsentRequired).toHaveBeenCalledTimes(1);
    space.send("me");
    await tick();
    expect(space.replies).toHaveLength(1);
  });

  it("maps a server error body straight through", async () => {
    const { space, api } = started();
    api.call.mockRejectedValueOnce(
      new SpaceApiError(502, { code: "UPSTREAM_ERROR", message: "boom", integration: "github", tool: "github_list_prs" })
    );
    const r = await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect(r.error).toEqual({ code: "UPSTREAM_ERROR", message: "boom", integration: "github", tool: "github_list_prs" });
  });

  it("maps an unexpected failure to UPSTREAM_ERROR", async () => {
    const { space, api } = started();
    api.call.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const r = await space.send("call", { integration: "github", tool: "list_prs" }).reply;
    expect((r.error as { code: string }).code).toBe("UPSTREAM_ERROR");
  });
});

describe("me and kv", () => {
  it("answers me from the shell", async () => {
    const { space } = started();
    expect((await space.send("me").reply).result).toEqual({ email: "dev@example.com" });
  });

  it("serves kv.get, kv.set, kv.delete and kv.keys", async () => {
    const { space, api } = started();
    expect((await space.send("kv.get", { key: "k" }).reply).result).toEqual({ saved: true });
    expect(api.kvGet).toHaveBeenCalledWith("k");
    expect((await space.send("kv.set", { key: "k", value: [1] }).reply).ok).toBe(true);
    expect(api.kvSet).toHaveBeenCalledWith("k", [1]);
    expect((await space.send("kv.delete", { key: "k" }).reply).ok).toBe(true);
    expect(api.kvDelete).toHaveBeenCalledWith("k");
    expect((await space.send("kv.keys").reply).result).toEqual(["a", "b"]);
  });

  it("refuses a kv request without a string key", async () => {
    const { space, api } = started();
    const r = await space.send("kv.get", { key: 5 }).reply;
    expect((r.error as { code: string }).code).toBe("INVALID_ARGS");
    expect(api.kvGet).not.toHaveBeenCalled();
  });

  it("passes a TOO_LARGE through", async () => {
    const { space, api } = started();
    api.kvSet.mockRejectedValueOnce(new SpaceApiError(413, { code: "TOO_LARGE", message: "too large" }));
    const r = await space.send("kv.set", { key: "k", value: "x" }).reply;
    expect(r.error).toEqual({ code: "TOO_LARGE", message: "too large" });
  });
});
