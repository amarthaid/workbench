import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { config } from "../config";
import { resolveMcpUser } from "../auth/oauth-server/resolve";
import {
  deleteSecret,
  listSecrets,
  putSecret,
  readSecretValue,
  touchUsed,
  VaultError,
} from "./store";
import { consumeOtl, mintAdhocOtl, OTL_MAX_TTL_SECONDS, revokeFor } from "./otl";
import { verifySession } from "../auth/session";

async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = await resolveMcpUser(request.headers as Record<string, string>);
  if (userId) return userId;
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

// Writes are portal-only, deliberately narrower than `authenticate`.
//
// `resolveMcpUser` accepts an API key or an OAuth access token — the agent's
// own credential. The vault's whole goal is that the agent can use a secret
// but never read one (spec Goal); a credential that can overwrite or delete
// a secret defeats that from the other side. It cannot read `hunter2`, but it
// could rotate it to a value it chose and then read that, or wipe the vault.
// So PUT/DELETE require the portal-session JWT, which only a signed-in human
// holds, and `verifySession` accepts nothing else.
// 401 and 403 mean different things here and the portal acts on the
// difference. 401 = no usable credential at all (missing, malformed, or an
// expired session JWT), carrying the same WWW-Authenticate header the rest of
// the API sends, so the portal's existing 401 handling clears `awb_token` and
// sends the human to sign in again. 403 = a credential the server does accept,
// just not for this — an API key or OAuth token — and re-authenticating would
// not help, so the portal must not log the human out over it.
async function authenticatePortal(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<string | null> {
  const header = (request.headers.authorization as string | undefined) ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (token) {
    try {
      const { userId } = await verifySession(token);
      if (userId) return userId;
    } catch {
      // Not a portal session. It may still be an agent credential — ask.
    }
    if (await resolveMcpUser(request.headers as Record<string, string>)) {
      reply.status(403).send({
        error: "PORTAL_SESSION_REQUIRED",
        message: "Secrets are written and deleted from the portal only.",
      });
      return null;
    }
  }
  const prm = `${config.SERVER_PUBLIC_URL}/.well-known/oauth-protected-resource`;
  reply.header("WWW-Authenticate", `Bearer realm="a-workbench", resource_metadata="${prm}"`);
  reply.status(401).send({ error: "Unauthorized", resource_metadata: prm });
  return null;
}

// Portal-minted links default to 5 minutes: a human copies the URL into a chat
// by hand. The hard ceiling stays OTL_MAX_TTL_SECONDS.
export const OTL_PORTAL_DEFAULT_TTL_SECONDS = 300;

function statusFor(code: VaultError["code"]): number {
  switch (code) {
    case "INVALID_NAME":
    case "EMPTY_VALUE":
      return 400;
    case "NOT_FOUND":
      return 404;
    case "TOO_LARGE":
      return 413;
  }
}

export async function registerVaultRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/vault", async (request, reply) => {
    const userId = await authenticate(request, reply);
    if (!userId) return reply;
    return reply.send({ secrets: await listSecrets(userId) });
  });

  // The only route that ever carries a plaintext value, and only the portal
  // calls it. Fastify does not log bodies.
  app.put<{ Params: { name: string }; Body: unknown }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const body = (request.body ?? {}) as { value?: unknown; description?: unknown };
    if (typeof body.value !== "string") return reply.code(400).send({ error: "INVALID_VALUE" });
    if (body.description !== undefined && body.description !== null && typeof body.description !== "string") {
      return reply.code(400).send({ error: "INVALID_DESCRIPTION" });
    }
    try {
      // Pass description through unchanged: undefined = leave the existing
      // description alone (store's UPDATE branch), null = clear it, string =
      // set it. Collapsing undefined to null here would wipe the description
      // on every value-only overwrite.
      const description = body.description as string | null | undefined;
      const { created } = await putSecret(userId, request.params.name, body.value, description);
      return reply.code(created ? 201 : 200).send({ ok: true, created });
    } catch (e) {
      if (e instanceof VaultError) return reply.code(statusFor(e.code)).send({ error: e.code });
      throw e;
    }
  });

  app.delete<{ Params: { name: string } }>("/api/vault/:name", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const gone = await deleteSecret(userId, request.params.name);
    if (!gone) return reply.code(404).send({ error: "NOT_FOUND" });
    await revokeFor(userId, request.params.name);
    return reply.code(204).send();
  });

  // Mint a one-time link for a value that is never stored in the vault. The
  // second route that carries a plaintext value in its body, portal-only for
  // the same reason PUT is: an agent credential must not be able to launder a
  // value through a link it can then fetch. Not exposed as an MCP tool.
  app.post<{ Body: unknown }>("/api/vault/otl", async (request, reply) => {
    const userId = await authenticatePortal(request, reply);
    if (!userId) return reply;
    const body = (request.body ?? {}) as { value?: unknown; ttl_seconds?: unknown };
    if (typeof body.value !== "string") return reply.code(400).send({ error: "INVALID_VALUE" });
    let ttl = OTL_PORTAL_DEFAULT_TTL_SECONDS;
    if (body.ttl_seconds !== undefined) {
      if (typeof body.ttl_seconds !== "number" || !Number.isFinite(body.ttl_seconds) || body.ttl_seconds < 1) {
        return reply.code(400).send({ error: "INVALID_TTL" });
      }
      ttl = Math.min(body.ttl_seconds, OTL_MAX_TTL_SECONDS);
    }
    try {
      const minted = await mintAdhocOtl(userId, body.value, ttl);
      return reply.code(201).send({ url: minted.url, expires_at: Math.ceil(minted.expiresAt / 1000) });
    } catch (e) {
      if (e instanceof VaultError) return reply.code(statusFor(e.code)).send({ error: e.code });
      throw e;
    }
  });

  // One-time redeem. No bearer: the token is the authorization, single-use,
  // minutes of TTL. The user whose value is read comes from the row. Silent in
  // the request log because the token is the URL.
  app.get<{ Params: { token: string } }>(
    "/api/vault/otl/:token",
    { logLevel: "silent" },
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("x-content-type-options", "nosniff");
      reply.header("content-disposition", 'attachment; filename="secret.txt"');
      const grant = await consumeOtl(request.params.token);
      if (!grant) return reply.code(404).send();
      // Ad hoc: the value came out of the row itself; nothing to stamp.
      if (grant.value !== undefined) return reply.type("text/plain; charset=utf-8").send(grant.value);
      const value = await readSecretValue(grant.userId, grant.name);
      if (value === null) return reply.code(404).send();
      // Awaited, not fire-and-forget: the last_used_at test relies on the
      // stamp landing before the redeem response is observed. The value is
      // already decrypted, so awaiting here trades no secrecy for the
      // ordering guarantee. A failed stamp must never turn a 200 into a 500.
      try {
        await touchUsed(grant.userId, [grant.name]);
      } catch {
        // ignore
      }
      return reply.type("text/plain; charset=utf-8").send(value);
    }
  );
}
