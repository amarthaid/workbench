// Copies the brand favicon (and the one-time-link unfurl card, which the
// server's GET /api/vault/otl/:token page names as og:image) into public/ so
// they are served by path.
// packages/brand/dist is gitignored and, with BRAND_SKIP_PNG=1 (set for the
// Docker builder stage, which has no Chromium to render the PNGs), the PNG
// files never land there at all. Fall back to the committed copies under
// docs/assets/brand so the portal build still succeeds.
import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "..", "brand", "dist");
const fallbackSrc = join(here, "..", "..", "..", "docs", "assets", "brand");
const dst = join(here, "..", "public");
mkdirSync(dst, { recursive: true });
for (const f of ["favicon.svg", "apple-touch-180.png", "og-otl-1200x630.png"]) {
  const primary = join(src, f), fallback = join(fallbackSrc, f);
  if (existsSync(primary)) copyFileSync(primary, join(dst, f));
  else if (existsSync(fallback)) copyFileSync(fallback, join(dst, f));
  else throw new Error(
    `copy-brand: missing ${f} at both ${primary} and ${fallback}. ` +
    `Run "npm run build -w @a-workbench/brand" to generate it.`
  );
}
