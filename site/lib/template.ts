import { markSvg, LOCKUP } from "@a-workbench/brand";
import type { Inventory } from "./inventory";

export interface ReplayStep { prompt?: string; call?: { tool: string; args: Record<string, unknown> }; result?: string }

// The replay is authored copy, so any count in it would go stale the moment a
// plugin lands. `{{tools}}` is filled from the same inventory the strip renders.
export function fillReplay(replay: ReplayStep[], totals: Inventory["totals"]): ReplayStep[] {
  const sub = (s: string) => s.replace(/\{\{tools\}\}/g, String(totals.tools));
  return replay.map((step) => ({
    ...step,
    ...(step.prompt === undefined ? {} : { prompt: sub(step.prompt) }),
    ...(step.result === undefined ? {} : { result: sub(step.result) }),
  }));
}

export interface PageData { inventory: Inventory; replay: ReplayStep[]; docsUrl: string; repoUrl: string; image: string; shots: { apps: string; connect: string; result: string }; logoUrls: string[] }

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const DOCKER = "docker run -p 3001:3001 -v workbench-data:/app/data ghcr.io/barockok/workbench";

export function renderPage(d: PageData): string {
  const { totals, integrations } = d.inventory;
  const counts = `${plural(totals.integrations, "integration")} · ${plural(totals.tools, "tool")} · ${totals.metaTools} meta-tools`;
  const lockup = `<a class="brand" href="/">${markSvg({ size: LOCKUP.standard.mark, surface: "var(--bg)" })}<span class="brand-name">${LOCKUP.name}</span></a>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>workbench — one MCP endpoint for every tool your agent needs</title>
<meta name="description" content="Self-hosted MCP server. Per-user OAuth for ${counts}. Your tokens never leave your box.">
<meta property="og:title" content="workbench">
<meta property="og:description" content="One endpoint. Every tool your agent needs. Self-hosted, per-user OAuth, ${counts}.">
<meta property="og:image" content="${d.image}">
<meta property="og:type" content="website">
<link rel="icon" href="favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="apple-touch-180.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@500;700;800&family=JetBrains+Mono:wght@400;500&display=swap">
<link rel="stylesheet" href="tokens.css">
<link rel="stylesheet" href="site.css">
<script>(function(){try{var t=localStorage.getItem('wb-theme');if(t)document.documentElement.dataset.theme=t;}catch(e){}})();</script>
</head>
<body>
<header class="topbar">${lockup}<nav><a href="${esc(d.docsUrl)}">Docs</a><a href="${esc(d.repoUrl)}">GitHub</a></nav></header>

<section id="hero" class="hero">
  <canvas id="swarm" class="hero-canvas" aria-hidden="true"></canvas>
  <div class="hero-copy">
    <h1>One endpoint. Every tool your agent needs.</h1>
    <p class="lede">A self-hosted MCP server that holds a separate OAuth connection per user per provider and exposes ${plural(totals.tools, "tool")} across ${plural(totals.integrations, "integration")} through ${totals.metaTools} meta-tools. Your tokens never leave your box.</p>
    <div class="cta-row">
      <code class="cmd" data-copy="${esc(DOCKER)}"><span>${esc(DOCKER)}</span><button type="button" class="copy" aria-label="Copy command">Copy</button></code>
      <a class="button-secondary" href="${esc(d.docsUrl)}start/quickstart.html">Read the docs</a>
    </div>
  </div>
</section>

<section id="integrations" class="strip">
  <p class="strip-counts">${counts}</p>
  <ul class="logos">${integrations.map((i) => `<li title="${esc(i.displayName)} · ${plural(i.toolCount, "tool")}">${i.logoSvg}<span>${esc(i.displayName)}</span></li>`).join("")}</ul>
</section>

<section id="demo" class="demo">
  <div class="demo-col">
    <p class="eyebrow">For the agent</p>
    <h2>Three meta-tools, any integration.</h2>
    <div class="terminal" id="terminal" aria-live="polite"></div>
    <script id="replay-data" type="application/json">${JSON.stringify(d.replay).replace(/</g, "\\u003c")}</script>
  </div>
  <div class="demo-col">
    <p class="eyebrow">For you</p>
    <h2>Connect once. Revoke any time.</h2>
    <figure><img src="${esc(d.shots.apps)}" alt="The Apps page listing every integration with its tool count" loading="lazy"></figure>
    <figure><img src="${esc(d.shots.connect)}" alt="An agent asking for access to Google Sheets, with Approve and Cancel" loading="lazy"></figure>
    <figure><img src="${esc(d.shots.result)}" alt="Google Sheets connected — the success card with a link back to the dashboard" loading="lazy"></figure>
  </div>
</section>

<section id="pillars" class="pillars">
  <article><h3>Constant context</h3><p>The agent sees nine tools whether one integration is connected or all ${totals.integrations}. Everything else is reached by name.</p><a href="${esc(d.docsUrl)}start/concepts.html">How meta-tools work →</a></article>
  <article><h3>Per-user OAuth</h3><p>One token per person per provider, injected server-side. The agent never holds a credential.</p><a href="${esc(d.docsUrl)}start/how-it-works.html">The request path →</a></article>
  <article><h3>Yours to run</h3><p>SQLite or PostgreSQL, tokens encrypted at rest with AES-256-GCM, one container.</p><a href="${esc(d.docsUrl)}deploy/install.html">Deploy →</a></article>
</section>

<section id="contribute" class="contribute">
  <p class="eyebrow">Open source</p>
  <h2>${plural(totals.integrations, "integration")} today. Yours next.</h2>
  <div class="contribute-col">
    <pre class="code">${esc(`custom-plugins/acme-wiki/
├── manifest.ts
└── tools/index.ts

// manifest.ts
export default {
  name: "acme-wiki",
  displayName: "Acme Wiki",
  description: "Internal wiki — pages and search.",
  logo: "logo.svg",
  auth: { type: "apikey", header: "X-Api-Key" },
  proxy: { baseUrl: "https://wiki.acme.example" },
};`)}</pre>
  </div>
  <div class="contribute-col">
    <article><h3>No fork.</h3><p>Drop a folder into <code>custom-plugins/</code>; the server loads it on restart and the portal lists it beside the built-ins.</p></article>
    <article><h3>Keep it or share it.</h3><p>Private to your instance by default. Open a pull request when others would use it and it ships in the next release.</p></article>
    <article><h3>Same rules as ours.</h3><p>A manifest, a tools file, one of four auth modes — the built-in integrations are written exactly the same way.</p></article>
    <a href="${esc(d.docsUrl)}plugins/index.html">Build a plugin →</a>
  </div>
</section>

<section id="teams" class="teams">
  <p class="eyebrow">For teams</p>
  <h2>Set it up once. The whole org connects.</h2>
  <div class="teams-grid">
    <article><h3>One setup per provider.</h3><p>Client ID and secret live on the instance. Nobody hands out API keys or pastes secrets into an agent config.</p></article>
    <article><h3>Everyone brings their own account.</h3><p>Each person connects with one click; tokens are per-user, encrypted at rest, and the agent never sees them.</p></article>
    <article><h3>One audit trail.</h3><p>Every tool call is logged with who, which agent, which integration, and the outcome — the Activity page is the record.</p></article>
    <article><h3>Easy to govern.</h3><p>Revoke a person's connection or an agent's access in one place; it stops everywhere at once.</p></article>
  </div>
  <a href="${esc(d.docsUrl)}deploy/install.html">Deploy for your team →</a>
</section>

<section id="cta" class="close">
  <h2>Your agent already knows what to do. Give it the tools.</h2>
  <code class="cmd" data-copy="${esc(DOCKER)}"><span>${esc(DOCKER)}</span><button type="button" class="copy" aria-label="Copy command">Copy</button></code>
  <p><a href="${esc(d.repoUrl)}">GitHub</a> · <a href="${esc(d.docsUrl)}">Documentation</a> · MIT</p>
</section>

<script type="module">
  import { createSwarm } from "./brand/index.js";
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  const narrow = matchMedia("(max-width: 880px)").matches;
  createSwarm(document.getElementById("swarm"), narrow
    ? { ground: dark ? "dark" : "accent", markX: 0.5, markY: 0.3, markFrac: 0.58, ambient: false, "logos":${JSON.stringify(d.logoUrls)} }
    : { ground: dark ? "dark" : "accent", markY: 0.5, "logos":${JSON.stringify(d.logoUrls)} });
</script>
<script src="site.js" defer></script>
</body>
</html>`;
}
