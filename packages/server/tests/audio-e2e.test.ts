/**
 * Feasibility probe for the browser audio pipeline: a REAL PulseAudio daemon
 * and a REAL headless chromium, wired through the devices src/audio/pulse.ts
 * creates. Chromium plays a 440 Hz tone (must show up on the sink monitor) and
 * records from the mic source (must hear the 880 Hz tone we pacat into it).
 *
 * Needs Linux + pulseaudio + playwright's chromium, so it runs in a container:
 * scripts/test-audio-e2e.sh. Skipped loudly otherwise (`TEST_AUDIO=1` to run).
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";

const { cfg } = vi.hoisted(() => ({
  cfg: {
    SESSION_SECRET: "test-session-secret-32-chars-long!!",
    BROWSER_PROFILES_DIR: "",
    BROWSER_DISK_CACHE_MB: 32,
    BROWSER_LAUNCH_TIMEOUT_MS: 20_000,
    DATABASE_URL: process.env.DATABASE_URL, // pinned to a temp dir by vitest.config.ts
  },
}));
vi.mock("../src/config", () => ({ config: cfg }));

const ENABLED = process.env.TEST_AUDIO === "1";

if (!ENABLED) {
  console.warn(
    "[audio-e2e] TEST_AUDIO not set — real PulseAudio + chromium audio test SKIPPED. " +
      "Run scripts/test-audio-e2e.sh to cover it (needs Linux; macOS has no PulseAudio)."
  );
}

const PAGE = `<!doctype html><html><body><script>
const ctx = new AudioContext();
const osc = ctx.createOscillator();
osc.frequency.value = 440;
osc.connect(ctx.destination);
osc.start();
window.micFreq = async () => {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const c = new AudioContext();
  const an = c.createAnalyser();
  an.fftSize = 8192;
  c.createMediaStreamSource(stream).connect(an);
  await new Promise((r) => setTimeout(r, 1500));
  const d = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(d);
  let best = 1;
  for (let i = 2; i < d.length; i++) if (d[i] > d[best]) best = i;
  return best * c.sampleRate / an.fftSize;
};
</script></body></html>`;

function toneHz(pcm: Buffer, rate: number): number {
  let crossings = 0;
  let prev = pcm.readInt16LE(0);
  for (let i = 2; i + 1 < pcm.length; i += 2) {
    const s = pcm.readInt16LE(i);
    if ((prev < 0 && s >= 0) || (prev >= 0 && s < 0)) crossings++;
    prev = s;
  }
  return crossings / 2 / (pcm.length / 2 / rate);
}

// Filled in as each resource comes up, and torn down even when the test failed
// or timed out part-way, so no daemon or chromium outlives the run. Processes
// die in parallel (≤5 s together), then the daemon they were talking to (≤2.5 s,
// runtime dir removed after it exits), then the page server (≤2 s): worst case
// ~9.5 s, well inside the hook's 20 s.
const torn: {
  timer?: ReturnType<typeof setInterval>;
  clients: Array<{ close(): void }>;
  procs: ChildProcess[];
  pm?: { shutdown(): Promise<void> };
  server?: http.Server;
} = { clients: [], procs: [] };
afterAll(async () => {
  clearInterval(torn.timer);
  for (const c of torn.clients) { try { c.close(); } catch { /* best effort */ } }
  await Promise.all(torn.procs.map(killAndWait));
  try { await torn.pm?.shutdown(); } catch { /* best effort */ }
  const server = torn.server;
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => {
      const t = setTimeout(r, 2_000);
      server.close(() => { clearTimeout(t); r(); });
    });
  }
}, 20_000);

/** SIGKILL and wait (bounded) for the exit, so teardown order is real. */
function killAndWait(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(resolve, 5_000);
    proc.once("exit", () => { clearTimeout(t); resolve(); });
    proc.kill("SIGKILL");
  });
}

describe.skipIf(!ENABLED)("browser audio over real PulseAudio + chromium", () => {
  it("plays chromium audio to the sink and records the mic source", async () => {
    cfg.BROWSER_PROFILES_DIR = mkdtempSync(join(tmpdir(), "e2e-audio-prof-"));
    const { PulseManager, deviceKey } = await import("../src/audio/pulse");
    const { spawnProfileChromium } = await import("../src/auth/profile-chromium");
    const { CdpClient } = await import("../src/auth/browser-session");

    const server = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    torn.server = server;
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

    const key = deviceKey("e2e-user");
    const pm = new PulseManager({ key });
    torn.pm = pm;
    const devices = await pm.createDevices(key);

    const chrome = await spawnProfileChromium("e2e-user", {
      env: { ...pm.clientEnv(), PULSE_SINK: devices.sink, PULSE_SOURCE: devices.source },
      extraArgs: ["--autoplay-policy=no-user-gesture-required"],
    });
    torn.procs.push(chrome.proc);

    const browser = new CdpClient(chrome.cdpBrowserWsUrl);
    torn.clients.push(browser);
    await browser.ready;
    await browser.send("Browser.setPermission", {
      permission: { name: "microphone" },
      setting: "granted",
      origin,
    });
    const page = new CdpClient(chrome.cdpPageWsUrl);
    torn.clients.push(page);
    await page.ready;
    await page.send("Page.navigate", { url: origin });

    // Downlink: chromium's 440 Hz oscillator lands on the sink's monitor.
    const capStart = Date.now();
    const cap: ChildProcess = pm.capture(devices.sink, 24000);
    torn.procs.push(cap);
    const chunks: Buffer[] = [];
    let firstAudibleAt: number | undefined;
    cap.stdout!.on("data", (c: Buffer) => {
      chunks.push(c);
      if (firstAudibleAt === undefined && peak(c) > 0) firstAudibleAt = Date.now();
    });
    // Chromium needs a moment after navigate to load the page and open its
    // stream, and parec delivers nothing for its first ~2 s in the container
    // (measured). The stream also drops out for ~100-300 ms every few seconds
    // under Docker on a laptop (measured; chromium -> null sink underruns), which
    // wrecks a zero-crossing count that straddles one. So poll for a 1 s window
    // with no silent gap (a clipped 440 Hz sine never has 10 ms of zeros) and
    // measure that; the assertions on it are unchanged.
    const have = () => chunks.reduce((n, c) => n + c.length, 0);
    const peak = (b: Buffer) => {
      let m = 0;
      for (let i = 0; i + 1 < b.length; i += 2) m = Math.max(m, Math.abs(b.readInt16LE(i)));
      return m;
    };
    const hasGap = (b: Buffer) => {
      let run = 0;
      for (let i = 0; i + 1 < b.length; i += 2) {
        run = b.readInt16LE(i) === 0 ? run + 1 : 0;
        if (run >= 240) return true;
      }
      return false;
    };
    const lastSecond = () => {
      const all = Buffer.concat(chunks);
      return all.subarray(Math.max(0, all.length - 48000));
    };
    const t0 = Date.now();
    for (let ok = false; !ok && Date.now() - t0 < 20_000; ) {
      await new Promise((r) => setTimeout(r, 100));
      ok = have() >= 72000 && !hasGap(lastSecond());
    }
    const tail = lastSecond();
    const max = peak(tail);
    const all = Buffer.concat(chunks);
    let silent = 0;
    let blocks = 0;
    for (let i = 0; i + 4800 <= all.length; i += 4800, blocks++) if (peak(all.subarray(i, i + 4800)) === 0) silent++;
    const down = toneHz(tail, 24000);
    // Dropouts are counted from the first audible block on: the silence before
    // it is chromium opening its stream (1.8-2.2 s measured), which is bounded
    // separately as start-up, not a dropout.
    let onset = 0;
    while (onset + 4800 <= all.length && peak(all.subarray(onset, onset + 4800)) === 0) onset += 4800;
    const silentAfterOnset = silent - onset / 4800;
    const blocksAfterOnset = blocks - onset / 4800;
    const dropoutFraction = blocksAfterOnset ? silentAfterOnset / blocksAfterOnset : 1;
    const startupMs = firstAudibleAt === undefined ? Infinity : firstAudibleAt - capStart;
    console.log(
      `[audio-e2e] downlink captured=${have()}B max=${max} freq=${down.toFixed(1)}Hz waited=${Date.now() - t0}ms ` +
        `startup=${startupMs}ms (audio-time onset ${onset / 48}ms) ` +
        `dropoutFraction=${dropoutFraction.toFixed(3)} (${silentAfterOnset}/${blocksAfterOnset} 100ms blocks after onset; ` +
        `whole capture ${silent}/${blocks})`
    );
    expect(have()).toBeGreaterThanOrEqual(48000);
    expect(max).toBeGreaterThan(1000);
    expect(Math.abs(down - 440)).toBeLessThan(20);
    // The frequency is read off a clean window; these keep the stream's
    // start-up and its dropouts visible.
    expect(startupMs).toBeLessThan(5_000);
    expect(dropoutFraction).toBeLessThan(0.25);

    // Uplink: an 880 Hz tone pacat'd into the mic sink is what getUserMedia hears.
    const play: ChildProcess = pm.playback(devices.mic, 24000);
    // pacat may exit (or be killed in teardown) with a chunk still in flight;
    // without a listener that EPIPE is an uncaught exception that fails the run.
    play.stdin!.on("error", () => {});
    torn.procs.push(play);
    let n = 0;
    const timer = setInterval(() => {
      const buf = Buffer.alloc(960);
      for (let i = 0; i < 480; i++) {
        buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 880 * (n + i)) / 24000)), i * 2);
      }
      n += 480;
      if (n >= 24000 * 4) { clearInterval(timer); play.stdin!.end(); return; }
      play.stdin!.write(buf);
    }, 20);
    torn.timer = timer;

    const devs = (await page.send("Runtime.evaluate", {
      expression:
        "navigator.mediaDevices.getUserMedia({audio:true}).then((s)=>{s.getTracks().forEach((t)=>t.stop());return navigator.mediaDevices.enumerateDevices()}).then(l=>l.map(d=>d.kind+':'+d.label+':'+d.deviceId))",
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: string[] } };
    const listed = devs.result?.value ?? [];
    console.log(`[audio-e2e] enumerateDevices=${JSON.stringify(listed)}`);
    // Chromium sees only this user's daemon: one input (the remap source; it
    // hides monitors) and two outputs (the call sink and the mic sink), besides
    // the "default" aliases.
    const real = (kind: string) => listed.filter((d) => d.startsWith(`${kind}:`) && !d.endsWith(":default"));
    expect(real("audioinput")).toHaveLength(1);
    expect(real("audiooutput")).toHaveLength(2);

    const r = (await page.send("Runtime.evaluate", {
      expression: "window.micFreq()",
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: number }; exceptionDetails?: unknown };
    console.log(`[audio-e2e] uplink freq=${r.result?.value}Hz ${r.exceptionDetails ? JSON.stringify(r.exceptionDetails) : ""}`);
    expect(Math.abs((r.result?.value ?? 0) - 880)).toBeLessThan(30);
  }, 60_000);
});
