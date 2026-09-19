// Writes the static brand assets to dist/. SVGs come straight from the
// renderer; PNGs are screenshots of those SVGs taken with the Playwright the
// repo already has. Set BRAND_SKIP_PNG=1 to skip the browser step (no Chromium),
// BRAND_SYNC_STATIC=1 to refresh the committed copies under docs/assets/brand.
import { mkdirSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
mkdirSync(dist, { recursive: true });

const { markSvg, tokens, LOCKUP } = await import(pathToFileURL(join(dist, "index.js")).href);

function lockupSvg({ color, text }) {
  const m = LOCKUP.standard.mark, w = LOCKUP.standard.wordmark, gap = LOCKUP.gap;
  const inner = markSvg({ color, surface: "none" }).replace(/^<svg[^>]*>/, "").replace(/<\/svg>$/, "");
  const width = m + gap + Math.round(w * 0.62 * LOCKUP.name.length);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${m}" width="${width}" height="${m}" role="img" aria-label="workbench">` +
    `<svg x="0" y="0" width="${m}" height="${m}" viewBox="0 0 32 32">${inner}</svg>` +
    `<text x="${m + gap}" y="${Math.round(m * 0.72)}" font-family="Inter, -apple-system, system-ui, sans-serif" font-size="${w}" font-weight="700" letter-spacing="-0.01em" fill="${text}">${LOCKUP.name}</text></svg>`;
}

const files = {
  "mark.svg": markSvg({ color: tokens.accent, surface: "#ffffff" }),
  "mark-small.svg": markSvg({ color: tokens.accent, variant: "small" }),
  "mark-knockout.svg": markSvg({ color: tokens.accent, variant: "knockout" }),
  "favicon.svg": markSvg({ color: tokens.accent, variant: "small" }),
  "lockup-light.svg": lockupSvg({ color: tokens.accent, text: "#111928" }),
  "lockup-dark.svg": lockupSvg({ color: tokens.accentDark, text: "#e8eaed" }),
};
for (const [name, svg] of Object.entries(files)) writeFileSync(join(dist, name), svg);

// packages/brand/dist is gitignored, so GitHub cannot render the README's
// lockups from it and a browserless build has no source for the
// PNGs. docs/assets/brand holds committed copies of both. Writing them is a
// deliberate act — BRAND_SYNC_STATIC=1 — so a plain build never dirties
// tracked files; CI runs it and checks the SVGs still match.
const staticDir = join(here, "..", "..", "docs", "assets", "brand");
const sync = Boolean(process.env.BRAND_SYNC_STATIC);
if (sync) {
  mkdirSync(staticDir, { recursive: true });
  for (const f of ["lockup-light.svg", "lockup-dark.svg"]) writeFileSync(join(staticDir, f), files[f]);
}

if (process.env.BRAND_SKIP_PNG) { console.log("brand: skipped PNGs (BRAND_SKIP_PNG)"); process.exit(0); }

const PNGS = ["favicon-32.png", "apple-touch-180.png", "og-1200x630.png", "og-otl-1200x630.png"];
const { chromium } = await import("playwright");
const browser = await chromium.launch();
async function png(name, { width, height, html }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><body style="margin:0;background:transparent">${html}</body>`);
  await page.screenshot({ path: join(dist, name), omitBackground: true });
  await page.close();
}
await png("favicon-32.png", { width: 32, height: 32, html: markSvg({ color: tokens.accent, variant: "small", size: 32 }) });
await png("apple-touch-180.png", { width: 180, height: 180, html: markSvg({ color: tokens.accent, variant: "knockout", size: 180 }) });
await png("og-1200x630.png", {
  width: 1200, height: 630,
  html: `<div style="width:1200px;height:630px;background:${tokens.accent};display:flex;align-items:center;justify-content:center;gap:40px;font-family:Inter,-apple-system,system-ui,sans-serif">` +
        markSvg({ color: "#ffffff", surface: tokens.accent, size: 220 }) +
        `<span style="color:#fff;font-size:120px;font-weight:800;letter-spacing:-.03em">workbench</span></div>`,
});
// The unfurl card for a one-time vault link (GET /api/vault/otl/:token) —
// what Slack, Teams and friends show when the link is pasted into a chat.
await png("og-otl-1200x630.png", {
  width: 1200, height: 630,
  html: `<div style="width:1200px;height:630px;box-sizing:border-box;padding:0 96px;background:${tokens.accent};display:flex;flex-direction:column;justify-content:center;gap:36px;font-family:Inter,-apple-system,system-ui,sans-serif;color:#fff">` +
        `<div style="display:flex;align-items:center;gap:24px">` +
        markSvg({ color: "#ffffff", surface: tokens.accent, size: 96 }) +
        `<span style="font-size:56px;font-weight:800;letter-spacing:-.03em">workbench</span></div>` +
        `<div style="font-size:96px;font-weight:800;letter-spacing:-.03em;line-height:1">One-time secret</div>` +
        `<div style="font-size:36px;font-weight:500;color:${tokens.accentLine}">Opens once. Link previews don\u2019t spend it.</div></div>`,
});
await browser.close();
if (sync) for (const f of PNGS) copyFileSync(join(dist, f), join(staticDir, f));
console.log("brand: wrote", Object.keys(files).length + PNGS.length, "files to dist/" + (sync ? ` (static copies synced to ${staticDir})` : ""));
