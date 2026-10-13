import { FastifyInstance } from "fastify";

// This is a private operator console + API, never public content. Tell every
// well-behaved crawler to stay out: robots.txt blocks crawling, and an
// X-Robots-Tag on every response (HTML, API, assets, errors) blocks indexing
// of anything that is fetched anyway (e.g. a pasted link).
export const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
export const ROBOTS_TAG =
  "noindex, nofollow, noarchive, nosnippet, noimageindex";

export function registerRobots(app: FastifyInstance): void {
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Robots-Tag", ROBOTS_TAG);
    return payload;
  });

  app.get("/robots.txt", async (_request, reply) => {
    return reply.type("text/plain; charset=utf-8").send(ROBOTS_TXT);
  });
}
