import fs from "fs";
import path from "path";
import { FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { config } from "./config";

// The portal SPA is built to packages/portal/dist and copied into the image at
// /app/portal. Resolve whichever exists: PORTAL_DIST_DIR (default "./portal" →
// /app/portal in the container) first, then dev-tree fallbacks.
function findPortalDir(): string | undefined {
  const candidates = [
    path.resolve(config.PORTAL_DIST_DIR),
    path.resolve(process.cwd(), "../portal/dist"),
    path.resolve(process.cwd(), "../../packages/portal/dist"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return undefined;
}

// Serve the built portal as static files with SPA fallback: any GET that isn't
// an API/MCP/REST route and doesn't map to a file resolves to index.html, so
// client routes (e.g. the /connect/:integration magic-link page) load on hard
// refresh or direct navigation. API/MCP/REST 404s stay JSON.
export async function registerPortal(app: FastifyInstance): Promise<void> {
  const dir = findPortalDir();
  if (!dir) return;

  await app.register(fastifyStatic, { root: dir, prefix: "/" });

  app.setNotFoundHandler((request, reply) => {
    if (
      request.method === "GET" &&
      !request.url.startsWith("/api") &&
      !request.url.startsWith("/mcp") &&
      !request.url.startsWith("/rest") &&
      !request.url.startsWith("/.well-known")
    ) {
      return reply.sendFile("index.html");
    }
    return reply.code(404).send({ error: "Not found" });
  });
}
