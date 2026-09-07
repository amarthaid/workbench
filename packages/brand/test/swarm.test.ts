// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSwarm, loadMarkImage } from "../src/swarm/index";
import { ENTER_MS } from "../src/swarm/lanes";
import type { Mask } from "../src/swarm/sample";

// jsdom has no 2D context. A recording stub is enough: the engine only needs
// the calls to exist, and the tests read what was drawn.
function stubContext() {
  const calls: string[] = [];
  const ctx: Record<string, unknown> = { globalAlpha: 1, lineWidth: 1, strokeStyle: "", shadowBlur: 0, shadowColor: "" };
  for (const m of ["setTransform", "clearRect", "save", "restore", "translate", "rotate", "scale", "beginPath", "arc", "rect", "moveTo", "lineTo", "closePath", "stroke", "drawImage"]) ctx[m] = vi.fn(() => calls.push(m));
  return { ctx, calls };
}
// A 64×64 mask whose centre 32×32 is solid.
async function rasterize(): Promise<Mask> {
  const size = 64, data = new Uint8ClampedArray(size * size * 4);
  for (let y = 16; y < 48; y++) for (let x = 16; x < 48; x++) { const k = (y * size + x) * 4; data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 255; }
  return { size, data };
}

let canvas: HTMLCanvasElement, ctx: ReturnType<typeof stubContext>, clock = 0, rafCbs: FrameRequestCallback[] = [];
beforeEach(() => {
  clock = 0; rafCbs = [];
  ctx = stubContext();
  canvas = document.createElement("canvas");
  Object.defineProperty(canvas, "clientWidth", { value: 640 }); Object.defineProperty(canvas, "clientHeight", { value: 360 });
  vi.spyOn(canvas, "getContext").mockReturnValue(ctx.ctx as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { rafCbs.push(cb); return rafCbs.length; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("matchMedia", (q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
  document.body.innerHTML = ""; const host = document.createElement("div"); host.appendChild(canvas); document.body.appendChild(host);
});
afterEach(() => vi.unstubAllGlobals());
const tick = (ms: number) => { clock += ms; const cbs = rafCbs.splice(0); for (const cb of cbs) cb(clock); };
const now = () => clock;

describe("createSwarm", () => {
  it("samples the mask, then draws every particle each frame", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const n = s.state().count; expect(n).toBeGreaterThan(50);
    ctx.calls.length = 0; tick(16);
    expect(ctx.calls.filter((c) => c === "stroke").length).toBe(n);
    s.destroy();
  });

  it("is not done until ENTER_MS and blends the idle pose in over 1200ms after", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    tick(16); tick(ENTER_MS - 100);
    expect(s.state().done).toBe(false);
    tick(200);
    expect(s.state().done).toBe(true); expect(s.state().poseMix).toBeLessThan(0.3);
    tick(1300);
    expect(s.state().poseMix).toBe(1);
    s.destroy();
  });

  it("keeps every particle alpha at 1 on the hand-off frame (no blink)", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const alphas: number[] = [];
    (ctx.ctx.stroke as ReturnType<typeof vi.fn>).mockImplementation(() => alphas.push(ctx.ctx.globalAlpha as number));
    tick(16); tick(ENTER_MS); alphas.length = 0; tick(16);
    // Depth shading (thicker slab) scales body/rim alpha by 0.55–1.0 across the
    // slab's far-to-near span on top of the base 0.6/0.95 — so the floor is the
    // farthest body dot (0.6 × 0.55), not the base body alpha. Still >0, so
    // nothing is additionally faded out by age/life on this hand-off frame.
    expect(Math.min(...alphas)).toBeGreaterThanOrEqual(0.6 * 0.55);
    expect(Math.min(...alphas)).toBeLessThanOrEqual(0.6);
    s.destroy();
  });

  it("re-seeds onto an existing target, never off the mark", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    tick(16); tick(ENTER_MS + 2000);
    for (let i = 0; i < 400; i++) tick(16);   // long enough for every particle to have re-seeded at least once
    const targets = new Set(s.state().targets.map((t) => `${t.tx},${t.ty}`));
    for (const p of s.state().particles) expect(targets.has(`${p.tx},${p.ty}`)).toBe(true);
    s.destroy();
  });

  it("destroy cancels the frame and removes pointer listeners from the host", async () => {
    const host = canvas.parentElement!;
    const add = vi.spyOn(host, "addEventListener"), rem = vi.spyOn(host, "removeEventListener");
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    s.destroy();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    for (const [type] of add.mock.calls) expect(rem).toHaveBeenCalledWith(type, expect.any(Function));
  });

  it("with reduced motion, renders one posed frame and never schedules a loop", async () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} }));
    const s = createSwarm(canvas, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    expect(rafCbs.length).toBe(0);
    expect(ctx.calls.filter((c) => c === "stroke").length).toBeGreaterThan(0);
    s.destroy();
  });

  it("a stale rebuild does not land after a newer one supersedes it", async () => {
    const size = 64;
    function squareMask(lo: number, hi: number): Mask {
      const data = new Uint8ClampedArray(size * size * 4);
      for (let y = lo; y < hi; y++) for (let x = lo; x < hi; x++) { const k = (y * size + x) * 4; data[k] = data[k + 1] = data[k + 2] = data[k + 3] = 255; }
      return { size, data };
    }
    let call = 0;
    const pending: { resolve: (m: Mask) => void; mask: Mask }[] = [];
    // First build gets a large solid square (more particles); every later
    // build gets a smaller one (fewer particles) — resolving them out of
    // order must still land only the latest.
    const deferredRasterize = (): Promise<Mask> => {
      call++;
      const mask = call === 1 ? squareMask(4, 60) : squareMask(24, 40);
      return new Promise<Mask>((resolve) => pending.push({ resolve, mask }));
    };
    const s = createSwarm(canvas, { rasterize: deferredRasterize, now, ambient: false });
    await vi.waitFor(() => expect(pending.length).toBe(1));   // first (stale-to-be) build in flight
    s.replay();
    await vi.waitFor(() => expect(pending.length).toBe(2));   // second (latest) build in flight

    // Resolve the latest build first, then the stale one — the stale
    // resolution arriving after must not overwrite the latest state.
    pending[1].resolve(pending[1].mask);
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const freshCount = s.state().count;

    pending[0].resolve(pending[0].mask);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.state().count).toBe(freshCount);
    s.destroy();
  });

  it("a rasterize failure leaves ready false without an unhandled rejection, then replay() retries", async () => {
    let call = 0;
    const flakyRasterize = (): Promise<Mask> => {
      call++;
      return call === 1 ? Promise.reject(new Error("decode failed")) : rasterize();
    };
    const s = createSwarm(canvas, { rasterize: flakyRasterize, now, ambient: false });
    await new Promise((r) => setTimeout(r, 0));   // let the first (rejected) build settle
    expect(s.state().ready).toBe(false);
    s.replay();
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    expect(s.state().count).toBeGreaterThan(0);
    s.destroy();
  });

  it("loadMarkImage evicts a failed decode from the cache so a retry gets a fresh Image", async () => {
    const svg = "<svg data-eviction-test/>";
    class FakeImage {
      static instances: FakeImage[] = [];
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      src = "";
      constructor() { FakeImage.instances.push(this); }
    }
    vi.stubGlobal("Image", FakeImage as unknown as typeof Image);

    const p1 = loadMarkImage(svg);
    expect(FakeImage.instances.length).toBe(1);
    FakeImage.instances[0].onerror?.();
    await expect(p1).rejects.toThrow();

    const p2 = loadMarkImage(svg);
    expect(FakeImage.instances.length).toBe(2);   // eviction meant a fresh Image, not the rejected one
    FakeImage.instances[1].onload?.();
    await expect(p2).resolves.toBe(FakeImage.instances[1]);
  });

  it("keeps the mark inside a narrow canvas instead of overrunning its edge", async () => {
    const narrow = document.createElement("canvas");
    Object.defineProperty(narrow, "clientWidth", { value: 400 });
    Object.defineProperty(narrow, "clientHeight", { value: 900 });
    vi.spyOn(narrow, "getContext").mockReturnValue(ctx.ctx as unknown as CanvasRenderingContext2D);
    document.body.innerHTML = ""; const host = document.createElement("div"); host.appendChild(narrow); document.body.appendChild(host);

    const s = createSwarm(narrow, { rasterize, now, ambient: false });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const W = 400, markX = 0.66;
    for (const t of s.state().targets) {
      const px = t.tx + markX * W;
      expect(px).toBeGreaterThanOrEqual(0);
      expect(px).toBeLessThanOrEqual(W);
    }
    s.destroy();
  });

  it("markY moves the mark up so it clears copy pinned below it", async () => {
    const narrow = document.createElement("canvas");
    Object.defineProperty(narrow, "clientWidth", { value: 400 });
    Object.defineProperty(narrow, "clientHeight", { value: 900 });
    vi.spyOn(narrow, "getContext").mockReturnValue(ctx.ctx as unknown as CanvasRenderingContext2D);
    document.body.innerHTML = ""; const host = document.createElement("div"); host.appendChild(narrow); document.body.appendChild(host);

    const s = createSwarm(narrow, { rasterize, now, ambient: false, markY: 0.3 });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const H = 900, markY = 0.3;
    for (const t of s.state().targets) {
      const py = t.ty + markY * H;
      expect(py).toBeGreaterThanOrEqual(0);
      expect(py).toBeLessThanOrEqual(H * 0.6);
    }
    s.destroy();
  });

  it("with logos, builds a logo ambient layer instead of the shapes-based big layer", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: true, logos: ["a.svg", "b.svg"] });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    expect(s.state().logoCount).toBe(Math.round(640 / 140));
    expect(s.state().bigCount).toBe(0);
    s.destroy();
  });

  it("draws every logo sprite via drawImage and never rotates it", async () => {
    class StubImage { complete = true; naturalWidth = 10; src = ""; }
    const loadImage = () => new StubImage() as unknown as HTMLImageElement;
    const s = createSwarm(canvas, { rasterize, now, ambient: true, logos: ["a.svg", "b.svg"], loadImage });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const logoCount = s.state().logoCount;
    ctx.calls.length = 0;
    tick(16);
    expect(ctx.calls.filter((c) => c === "drawImage").length).toBe(logoCount);
    s.destroy();
  });

  it("keeps logo sprites within the given logoZone band, on landing and after drifting", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: true, logos: ["a.svg", "b.svg"], logoZone: [0.5, 1] });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    const W = 640;
    for (const l of s.state().logos) expect(l.x).toBeGreaterThanOrEqual(W * 0.5);
    tick(16); for (let i = 0; i < 200; i++) tick(16);
    for (const l of s.state().logos) expect(l.x).toBeGreaterThanOrEqual(W * 0.5);
    s.destroy();
  });

  it("without logos, drawImage is never called", async () => {
    const s = createSwarm(canvas, { rasterize, now, ambient: true });
    await vi.waitFor(() => expect(s.state().ready).toBe(true));
    ctx.calls.length = 0;
    tick(16);
    expect(ctx.calls.filter((c) => c === "drawImage").length).toBe(0);
    s.destroy();
  });
});
