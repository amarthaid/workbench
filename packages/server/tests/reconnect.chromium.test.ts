/**
 * Cookie auto-reconnect against a REAL chromium, end to end: the runner opens
 * a tab in the user's profile chromium, drives a recipe against a local login
 * fixture, captures the cookies the browser actually got, and probes them.
 *
 * reconnect-runner.test.ts and reconnect-dom.test.ts cover the rules with a
 * fake CDP page. This file is the one that catches chromium disagreeing with
 * the fill chain (main-world evaluate -> Page.getFrameTree -> DOM.describeNode
 * -> Page.createIsolatedWorld -> DOM.resolveNode -> Runtime.callFunctionOn),
 * which no fake can tell you.
 *
 * Runs only when `TEST_CHROMIUM=1` and playwright's chromium is installed,
 * since a browser download is not a test dependency; skipped loudly otherwise.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import WebSocket from "ws";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const auditLog = vi.hoisted(() => vi.fn(async (_e: unknown) => {}));
vi.mock("../src/audit/logger", () => ({ auditLogger: { log: auditLog } }));

import { db } from "../src/db";
import { config } from "../src/config";
import { registry } from "../src/plugins/registry";
import { putSecret } from "../src/vault/store";
import { getCookies, storeCookies } from "../src/auth/cookie";
import { openTab, closeTab, closeBrowserSession, getWarmSession } from "../src/auth/browser-session";
import { getReconnectState, updateReconnectState } from "../src/auth/reconnect/state";
import { fillSelector, StepError } from "../src/auth/reconnect/dom";
import { reconnectSession, __deps } from "../src/auth/reconnect/runner";

const ENABLED = process.env.TEST_CHROMIUM === "1";

if (!ENABLED) {
  console.warn(
    "[reconnect.chromium] TEST_CHROMIUM not set — real-browser reconnect test SKIPPED. " +
      "Run TEST_CHROMIUM=1 npx vitest run tests/reconnect.chromium.test.ts to cover it."
  );
}

const I = "acme-cookie";
const PW = "pw-abc";

// ---- fixture ---------------------------------------------------------------
// One server on 127.0.0.1:<port>. "localhost" (and *.localhost, which chromium
// resolves to loopback itself) reach the same socket and play the second host:
// the SSO IdP, or a look-alike host that must not receive a credential.

interface Hits { session: Record<string, string>[]; idp: Record<string, string>[] }
const hits: Hits = { session: [], idp: [] };

const page = (body: string, head = "") =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

// Mimics React's controlled input: React tracks the last value it saw through
// an instance-level `value` property and ignores an `input` event whose DOM
// value equals the tracked one; component state (what gets submitted) moves
// only on a real change. A fill that writes through the instance setter, or
// fires no `input`, would submit "".
const REACT_HEAD = `<script>
document.addEventListener("DOMContentLoaded", () => {
  const proto = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const state = {};
  for (const id of ["user", "pass"]) {
    const el = document.getElementById(id);
    let tracked = "";
    Object.defineProperty(el, "value", {
      configurable: true,
      get() { return proto.get.call(this); },
      set(v) { tracked = String(v); proto.set.call(this, v); },
    });
    state[id] = "";
    el.addEventListener("input", () => {
      const cur = proto.get.call(el);
      if (cur !== tracked) { tracked = cur; state[id] = cur; }
    });
  }
  const form = document.getElementById("login");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const out = document.createElement("form");
    out.method = "post"; out.action = "/session";
    for (const [k, v] of Object.entries(state)) {
      const i = document.createElement("input");
      i.type = "hidden"; i.name = k; i.value = v; out.appendChild(i);
    }
    document.body.appendChild(out);
    out.submit();
  });
});
</script>`;

// A hostile page: patches the main-world value setter and every event path to
// record anything written. The isolated-world fill must leave this empty.
const HOSTILE_HEAD = `<script>
window.__stolen = [];
const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
Object.defineProperty(HTMLInputElement.prototype, "value", {
  configurable: true,
  get() { return d.get.call(this); },
  set(v) { window.__stolen.push(String(v)); d.set.call(this, v); },
});
const origDispatch = EventTarget.prototype.dispatchEvent;
EventTarget.prototype.dispatchEvent = function (ev) {
  try { window.__stolen.push("evt:" + d.get.call(this)); } catch {}
  return origDispatch.call(this, ev);
};
</script>`;

function loginPage(opts: { error?: boolean; mode?: string }, port: number): string {
  const head = opts.mode === "react" ? REACT_HEAD : opts.mode === "hostile" ? HOSTILE_HEAD : "";
  return page(
    `${opts.error ? '<p id="after-submit" class="error">Invalid credentials</p>' : ""}
     <form id="login" method="post" action="/session">
       <input id="user" name="user" type="text" autocomplete="username">
       <input id="pass" name="pass" type="password" autocomplete="current-password">
       <button type="submit">Sign in</button>
     </form>
     <a href="http://localhost:${port}/idp"><button type="button">Sign in with SSO</button></a>`,
    head
  );
}

async function startFixture(): Promise<{ app: FastifyInstance; port: number }> {
  const app = Fastify();
  app.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string" }, (_req, body, done) => {
    done(null, Object.fromEntries(new URLSearchParams(body as string)));
  });
  let port = 0;
  const html = (reply: FastifyReply, s: string) => reply.type("text/html").send(s);
  const hasSid = (cookie?: string) => (cookie ?? "").split(/;\s*/).includes("sid=ok");

  app.get("/login", (req, reply) => html(reply, loginPage({ mode: (req.query as { mode?: string }).mode }, port)));
  app.post("/session", (req, reply) => {
    const body = req.body as Record<string, string>;
    hits.session.push(body);
    if (body.pass === PW) {
      return reply.header("set-cookie", "sid=ok; Path=/; HttpOnly").redirect("/home", 302);
    }
    return html(reply, loginPage({ error: true }, port));
  });
  // IdP on the second host: a password form that, on success, bounces back to
  // the app's /sso, which is what sets the app cookie.
  app.get("/idp", (_req, reply) =>
    html(reply, page(`<form method="post" action="/idp/session">
      <input id="idp-pass" name="pass" type="password"><button type="submit">Continue</button></form>`))
  );
  app.post("/idp/session", (req, reply) => {
    const body = req.body as Record<string, string>;
    hits.idp.push(body);
    if (body.pass === PW) return reply.redirect(`http://127.0.0.1:${port}/sso`, 302);
    return html(reply, page("<p>denied</p>"));
  });
  app.get("/sso", (_req, reply) => reply.header("set-cookie", "sid=ok; Path=/; HttpOnly").redirect("/home", 302));
  app.get("/home", (req, reply) =>
    html(reply, page(`<p id="after-submit">${hasSid(req.headers.cookie) ? "welcome" : "anonymous"}</p>`))
  );
  app.get("/api/me", (req, reply) => reply.code(hasSid(req.headers.cookie) ? 200 : 401).send({}));
  app.get("/mfa", (_req, reply) => html(reply, page('<input id="code" placeholder="Enter the code we sent you">')));

  await app.listen({ port: 0, host: "127.0.0.1" });
  port = (app.server.address() as { port: number }).port;
  return { app, port };
}

// ---- harness ---------------------------------------------------------------

const users: string[] = [];
let n = 0;
/** A fresh user per case: a fresh profile chromium, no cooldown, no fast path. */
function freshUser(): string {
  const u = `e2e-reconnect-${process.pid}-${++n}`;
  users.push(u);
  return u;
}

describe.skipIf(!ENABLED)("cookie auto-reconnect against a real chromium", () => {
  let app: FastifyInstance;
  let port = 0;
  let origin = "";
  const savedProfiles = config.BROWSER_PROFILES_DIR;
  const savedInternal = config.INTERNAL_MCP_URL;
  const savedProbe = __deps.probe;

  beforeAll(async () => {
    config.BROWSER_PROFILES_DIR = mkdtempSync(join(tmpdir(), "e2e-reconnect-prof-"));
    config.INTERNAL_MCP_URL = undefined; // single process: this process owns the browser
    ({ app, port } = await startFixture());
    origin = `http://127.0.0.1:${port}`;
    // Ruling (a): the runner probes https://<targetDomain><path>; point it at
    // the fixture over http instead of changing production URL building.
    __deps.probe = async (url, cookieHeader) => {
      const u = new URL(url);
      const res = await fetch(`${origin}${u.pathname}${u.search}`, {
        headers: { Cookie: cookieHeader },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      });
      return res.status;
    };
  });

  afterAll(async () => {
    for (const u of users) await closeBrowserSession(u).catch(() => {});
    __deps.probe = savedProbe;
    config.BROWSER_PROFILES_DIR = savedProfiles;
    config.INTERNAL_MCP_URL = savedInternal;
    await app?.close();
  });

  beforeEach(() => {
    hits.session.length = 0;
    hits.idp.length = 0;
    auditLog.mockClear();
  });

  function useRecipe(reconnect: Record<string, unknown>): void {
    const auth = {
      type: "cookie" as const,
      loginUrl: `${origin}/login`,
      targetDomain: "127.0.0.1",
      session: { probe: { path: "/api/me", alive: [200] }, dead: { status: [401] } },
      reconnect: { credentials: [{ key: "password", label: "Password", secret: true }], ...reconnect },
    };
    vi.spyOn(registry, "getIntegration").mockReturnValue({ name: I, version: "1", auth } as any);
  }

  /** A connected-but-stale row bound to vault entry `acme_pw` holding `pw`. */
  async function seed(u: string, pw: string): Promise<void> {
    await db.run("DELETE FROM connections WHERE user_id = ?", [u]);
    await storeCookies(u, I, {
      domain: "127.0.0.1",
      cookies: [{ name: "sid", value: "stale", domain: "127.0.0.1", path: "/" }],
      capturedAt: 1,
    });
    await putSecret(u, "acme_user", "dev@example.com");
    await putSecret(u, "acme_pw", pw);
    await updateReconnectState(u, I, { bindings: { username: "acme_user", password: "acme_pw" } });
  }

  const PASSWORD_STEPS = (mode?: string) => [
    { goto: mode ? `${origin}/login?mode=${mode}` : "loginUrl" },
    { fill: "#user", value: "{{cred:username}}" },
    { fill: "#pass", value: "{{cred:password}}" },
    { press: "Enter" },
    // Both the logged-in /home and the re-rendered error page carry this, so
    // the same recipe settles for a right and a wrong password.
    { waitFor: "#after-submit" },
  ];
  const PASSWORD_CREDS = [
    { key: "username", label: "Username" },
    { key: "password", label: "Password", secret: true },
  ];

  async function expectStoredSid(u: string): Promise<void> {
    const stored = await getCookies(u, I);
    expect(stored?.cookies.find((c) => c.name === "sid")?.value).toBe("ok");
    const st = await getReconnectState(u, I);
    expect(st.deadAt).toBeUndefined();
    expect(st.last?.ok).toBe(true);
  }

  it("password recipe: fills, submits pw-abc, stores sid=ok", async () => {
    const u = freshUser();
    await seed(u, PW);
    useRecipe({ credentials: PASSWORD_CREDS, steps: PASSWORD_STEPS(), timeoutMs: 30_000 });

    expect(await reconnectSession(u, I)).toEqual({ ok: true });
    expect(hits.session).toEqual([{ user: "dev@example.com", pass: PW }]);
    await expectStoredSid(u);
    expect(auditLog).toHaveBeenCalledWith(expect.objectContaining({ action: "REFRESH", success: true }));
    // The recipe tab is closed; only chromium's default tab remains registered.
    expect(getWarmSession(u)?.tabs.size).toBe(1);
  }, 60_000);

  it("React-style controlled inputs see the fill and submit pw-abc", async () => {
    const u = freshUser();
    await seed(u, PW);
    useRecipe({ credentials: PASSWORD_CREDS, steps: PASSWORD_STEPS("react"), timeoutMs: 30_000 });

    expect(await reconnectSession(u, I)).toEqual({ ok: true });
    expect(hits.session).toEqual([{ user: "dev@example.com", pass: PW }]);
    await expectStoredSid(u);
  }, 60_000);

  it("SSO recipe: clicks through to the IdP host (allowHosts) and back", async () => {
    const u = freshUser();
    await seed(u, PW);
    useRecipe({
      allowHosts: ["localhost"],
      steps: [
        { goto: "loginUrl" },
        { click: "text=Sign in with SSO" },
        { waitUrl: `http://localhost:${port}/idp` },
        { fill: "#idp-pass", value: "{{cred:password}}" },
        { click: "text=Continue" },
        { waitUrl: `${origin}/home` },
      ],
      timeoutMs: 30_000,
    });

    expect(await reconnectSession(u, I)).toEqual({ ok: true });
    expect(hits.idp).toEqual([{ pass: PW }]);
    await expectStoredSid(u);
  }, 60_000);

  it("SSO without the IdP in allowHosts stops at the IdP: HOST_NOT_ALLOWED", async () => {
    const u = freshUser();
    await seed(u, PW);
    useRecipe({
      steps: [
        { goto: "loginUrl" },
        { click: "text=Sign in with SSO" },
        { waitFor: "#idp-pass" }, // any step that starts on localhost
        { fill: "#idp-pass", value: "{{cred:password}}" },
      ],
      timeoutMs: 30_000,
    });

    expect(await reconnectSession(u, I)).toEqual({ ok: false, reason: "HOST_NOT_ALLOWED", step: 2 });
    expect(hits.idp).toEqual([]);
  }, 60_000);

  it("a fill on a host that is only suffix-allowed (not exact) is refused in the page", async () => {
    // The runner's per-step guard allows subdomains of an allowed host, so
    // idp.localhost passes it; the delivery function's exact-host check is
    // what must refuse, inside chromium, before the value is written.
    const u = freshUser();
    await seed(u, PW);
    useRecipe({
      allowHosts: ["localhost"],
      steps: [
        { goto: `http://idp.localhost:${port}/login` },
        { fill: "#pass", value: "{{cred:password}}" },
        { press: "Enter" },
      ],
      timeoutMs: 30_000,
    });

    expect(await reconnectSession(u, I)).toEqual({ ok: false, reason: "HOST_NOT_ALLOWED", step: 1 });
    expect(hits.session).toEqual([]);
    expect((await getReconnectState(u, I)).last?.error).toBe("step 1: HOST_NOT_ALLOWED");
  }, 60_000);

  it("wrong password: fails closed with deadAt set", async () => {
    const u = freshUser();
    await seed(u, "pw-wrong");
    useRecipe({ credentials: PASSWORD_CREDS, steps: PASSWORD_STEPS(), timeoutMs: 30_000 });

    const out = await reconnectSession(u, I);
    expect(out.ok).toBe(false);
    expect(["PROBE_FAILED", "NO_COOKIES"]).toContain((out as { reason: string }).reason);
    expect(hits.session).toEqual([{ user: "dev@example.com", pass: "pw-wrong" }]);
    const st = await getReconnectState(u, I);
    expect(st.deadAt).toBeTypeOf("number");
    expect(st.last?.ok).toBe(false);
    expect((await getCookies(u, I))?.cookies[0].value).toBe("stale");
  }, 60_000);

  it("MFA that never completes: TIMEOUT within timeoutMs + 2s", async () => {
    const u = freshUser();
    await seed(u, PW);
    // Warm the chromium first so the measured window is the recipe, not a cold spawn.
    const warm = await openTab(u);
    if (warm.ok) await closeTab(u, warm.tab.id);
    const timeoutMs = 3_000;
    useRecipe({ steps: [{ goto: `${origin}/mfa` }, { waitUrl: "/home" }], timeoutMs });

    const t0 = Date.now();
    const out = await reconnectSession(u, I);
    const took = Date.now() - t0;
    expect(out).toMatchObject({ ok: false, reason: "TIMEOUT" });
    expect(took).toBeLessThan(timeoutMs + 2_000);
    expect((await getReconnectState(u, I)).deadAt).toBeTypeOf("number");
  }, 60_000);

  describe("fillSelector directly", () => {
    let u = "";
    beforeAll(() => {
      u = freshUser();
    });

    async function withTab<T>(url: string, fn: (tab: Awaited<ReturnType<typeof openTab>> & { ok: true }) => Promise<T>) {
      const opened = await openTab(u);
      if (!opened.ok) throw new Error("no tab");
      try {
        await opened.tab.cdp.send("Page.navigate", { url });
        return await fn(opened);
      } finally {
        await closeTab(u, opened.tab.id);
      }
    }
    const read = async (tab: { cdp: { send: (m: string, p?: any) => Promise<any> } }, expression: string) =>
      (await tab.cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

    it("a hostile page's patched value setter and dispatchEvent never see the value", async () => {
      await withTab(`${origin}/login?mode=hostile`, async ({ tab }) => {
        await fillSelector(tab, "#pass", PW, 10_000, ["127.0.0.1"]);
        expect(await read(tab, `document.getElementById("pass").value`)).toBe(PW);
        const stolen = (await read(tab, "JSON.stringify(window.__stolen)")) as string;
        expect(stolen).not.toContain(PW);
      });
    }, 60_000);

    it("refuses delivery on a host not exactly in the list; the input stays empty", async () => {
      await withTab(`http://localhost:${port}/login`, async ({ tab }) => {
        await expect(fillSelector(tab, "#pass", PW, 10_000, ["127.0.0.1"])).rejects.toMatchObject({
          reason: "HOST_NOT_ALLOWED",
        });
        expect(await read(tab, `document.getElementById("pass").value`)).toBe("");
      });
    }, 60_000);

    it("needs no DOM.enable / Page.enable: works on a bare page socket with no domain enabled", async () => {
      const s = getWarmSession(u);
      if (!s) throw new Error("no warm session");
      const created = (await (
        await fetch(`http://127.0.0.1:${s.remotePort}/json/new?${encodeURIComponent(`${origin}/login`)}`, { method: "PUT" })
      ).json()) as { id: string; webSocketDebuggerUrl: string };
      const ws = new WebSocket(created.webSocketDebuggerUrl, { perMessageDeflate: false, origin: "http://127.0.0.1" });
      await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
      let id = 0;
      const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
      const methods: string[] = [];
      ws.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        const p = typeof msg.id === "number" ? pending.get(msg.id) : undefined;
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.rej(new Error(msg.error.message));
        else p.res(msg.result ?? {});
      });
      const bare = {
        cdp: {
          send: (method: string, params: Record<string, unknown> = {}) => {
            methods.push(method);
            return new Promise<any>((res, rej) => {
              const i = ++id;
              pending.set(i, { res, rej });
              ws.send(JSON.stringify({ id: i, method, params }));
            });
          },
        },
      };
      try {
        // Let the /json/new navigation land.
        for (let i = 0; i < 50; i++) {
          const ready = (await bare.cdp.send("Runtime.evaluate", { expression: "!!document.getElementById('pass')", returnByValue: true })).result?.value;
          if (ready) break;
          await new Promise((r) => setTimeout(r, 100));
        }
        methods.length = 0;
        await fillSelector(bare as any, "#pass", PW, 10_000, ["127.0.0.1"]);
        expect(methods.filter((m) => m.endsWith(".enable"))).toEqual([]);
        expect(methods).toEqual(expect.arrayContaining([
          "Page.getFrameTree", "DOM.describeNode", "Page.createIsolatedWorld", "DOM.resolveNode", "Runtime.callFunctionOn",
        ]));
        const v = (await bare.cdp.send("Runtime.evaluate", { expression: `document.getElementById("pass").value`, returnByValue: true })).result?.value;
        expect(v).toBe(PW);
      } finally {
        ws.close();
        await fetch(`http://127.0.0.1:${s.remotePort}/json/close/${created.id}`).catch(() => {});
      }
    }, 60_000);

    it("text= selectors are rejected for fill before touching the page", async () => {
      await withTab(`${origin}/login`, async ({ tab }) => {
        await expect(fillSelector(tab, "text=Sign in", PW, 1_000, ["127.0.0.1"])).rejects.toBeInstanceOf(StepError);
      });
    }, 60_000);
  });

  // An agent tab that can load chromium's own /json endpoints reads every
  // target, private recipe tabs included (id, url, title), and GET
  // /json/close/<id> kills one. Agent tabs are blocked from the debug port
  // in the browser itself, so a script-driven navigation or an iframe (which
  // no URL check on browser_navigate sees) is refused as well.
  describe("agent tabs cannot load chromium's debug endpoint", () => {
    let u = "";
    beforeAll(() => {
      u = freshUser();
    });
    const settle = () => new Promise((r) => setTimeout(r, 800));
    const evalIn = async (tab: { cdp: { send: (m: string, p?: any) => Promise<any> } }, expression: string) =>
      (await tab.cdp.send("Runtime.evaluate", { expression, returnByValue: true })).result?.value;

    it("a script navigation to /json/list lands on an error page, not the target list", async () => {
      const opened = await openTab(u);
      if (!opened.ok) throw new Error("no tab");
      const { tab } = opened;
      try {
        const debug = `http://127.0.0.1:${getWarmSession(u)!.remotePort}`;
        await tab.cdp.send("Page.navigate", { url: `${origin}/login` });
        await settle();
        await evalIn(tab, `location.href = ${JSON.stringify(`${debug}/json/list`)}`);
        await settle();
        const text = String(await evalIn(tab, "document.body ? document.body.innerText : ''"));
        expect(text).not.toContain("webSocketDebuggerUrl");
      } finally {
        await closeTab(u, tab.id);
      }
    }, 60_000);

    it("an iframe pointed at /json/list never loads it", async () => {
      const opened = await openTab(u);
      if (!opened.ok) throw new Error("no tab");
      const { tab } = opened;
      try {
        const debug = `http://127.0.0.1:${getWarmSession(u)!.remotePort}`;
        await tab.cdp.send("Page.navigate", { url: `${origin}/login` });
        await settle();
        await evalIn(
          tab,
          `(() => { const f = document.createElement("iframe"); f.src = ${JSON.stringify(`${debug}/json/list`)}; document.body.appendChild(f); })()`
        );
        await settle();
        const tree = (await tab.cdp.send("Page.getFrameTree")) as any;
        const child = tree.frameTree.childFrames?.[0]?.frame;
        expect(child).toBeDefined();
        expect(child.unreachableUrl ?? "").toContain("/json/list");
      } finally {
        await closeTab(u, tab.id);
      }
    }, 60_000);

    it("the block does not touch other ports on loopback", async () => {
      const opened = await openTab(u);
      if (!opened.ok) throw new Error("no tab");
      const { tab } = opened;
      try {
        await tab.cdp.send("Page.navigate", { url: `${origin}/login` });
        await settle();
        expect(await evalIn(tab, "!!document.getElementById('pass')")).toBe(true);
      } finally {
        await closeTab(u, tab.id);
      }
    }, 60_000);
  });
});
