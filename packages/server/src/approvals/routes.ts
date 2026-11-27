import type { FastifyInstance, FastifyReply } from "fastify";
import { noteRequestAuth } from "../audit/context";
import { verifySession } from "../auth/session";
import { getUserById } from "../auth/users";
import { adminActor } from "../api/admin-scope";
import { cancel, createRequest, decide, inboxFor, mineFor } from "./engine";
import { ACCOUNT_ACTIVATE, SPACE_ACCESS, getKind, type Actor } from "./kinds";
import { countPending } from "./store";

// Two route groups, deliberately apart:
//
// - /api/admin/approvals/*: account.activate, inside the admin scope (the gate
//   reads the admin's email from the database; session only, an admin's API
//   key or OAuth token gets 401). Anything that activates an account stays
//   behind that gate.
// - /api/approvals/*: space.access and "mine", portal session only, the same
//   guard as the Space owner endpoints. It refuses account.activate rows.

const PORTAL_KINDS = [SPACE_ACCESS] as const;
const ADMIN_KINDS = [ACCOUNT_ACTIVATE] as const;

const MAX_PAGE = 100;
const DEFAULT_PAGE = 50;
const MINE_LIMIT = 50;
const SUBJECT_MAX = 256;

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "Not found" });
}

function bodyOf(request: { body?: unknown }): Record<string, unknown> {
  return request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
}

// ---- admin ------------------------------------------------------------------

export function registerAdminApprovalRoutes(scope: FastifyInstance): void {
  scope.get("/approvals", async (request) => {
    const q = request.query as { limit?: string; cursor?: string };
    const asked = Number.parseInt(q.limit ?? "", 10);
    const limit = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_PAGE) : DEFAULT_PAGE;
    const actor = adminActor(request);
    const kind = getKind(ACCOUNT_ACTIVATE)!;
    const [{ rows, next }, total] = await Promise.all([
      kind.inboxFor(actor, { limit, cursor: typeof q.cursor === "string" ? q.cursor : undefined }),
      countPending(ACCOUNT_ACTIVATE),
    ]);
    return {
      items: rows.map(({ request: r, requesterEmail }) => ({
        id: r.id,
        kind: r.kind,
        requester_email: requesterEmail,
        message: r.message,
        created_at: r.createdAt,
      })),
      next_cursor: next,
      pending_total: total,
    };
  });

  scope.post<{ Params: { id: string } }>("/approvals/:id/approve", async (request, reply) => {
    const result = await decide(adminActor(request), request.params.id, "approve", { kinds: ADMIN_KINDS });
    return result.ok ? { ok: true } : notFound(reply);
  });

  scope.post<{ Params: { id: string } }>("/approvals/:id/reject", async (request, reply) => {
    const result = await decide(adminActor(request), request.params.id, "reject", {
      kinds: ADMIN_KINDS,
      note: bodyOf(request).note,
    });
    return result.ok ? { ok: true } : notFound(reply);
  });
}

// ---- portal -----------------------------------------------------------------

const actors = new WeakMap<object, Actor>();

function actorOf(request: object): Actor {
  const a = actors.get(request);
  if (!a) throw new Error("actorOf called outside the approvals scope");
  return a;
}

export async function registerApprovalRoutes(app: FastifyInstance): Promise<void> {
  await app.register(
    async (scope) => {
      // Authorization: Bearer <portal session JWT> only (x-workbench-api-key is
      // ignored), as for the Space owner endpoints. verifySession also refuses
      // disabled and pending users.
      scope.addHook("preHandler", async (request, reply) => {
        const auth = request.headers.authorization;
        let session: { userId: string; email: string } | null = null;
        if (typeof auth === "string" && auth.startsWith("Bearer ")) {
          try {
            session = await verifySession(auth.slice(7));
          } catch {
            session = null;
          }
        }
        if (!session) return reply.code(401).send({ error: "Unauthorized" });
        // The email from the database, not the JWT: a token minted before an
        // email change must not keep matching the old share list.
        const user = await getUserById(session.userId);
        const email = user?.email ?? session.email ?? null;
        actors.set(request, { userId: session.userId, email: email ? email.toLowerCase() : null });
        noteRequestAuth(request, "session");
      });

      scope.get("/", async (request, reply) => {
        const actor = actorOf(request);
        const { scope: which } = request.query as { scope?: string };
        if (which === "inbox") {
          const rows = await inboxFor(actor, PORTAL_KINDS);
          const items = [];
          for (const { request: r, requesterEmail, delegated } of rows) {
            items.push({
              id: r.id,
              kind: r.kind,
              subject: r.subject,
              subject_label: await getKind(r.kind)!.subjectLabel(r),
              requester_email: requesterEmail,
              message: r.message,
              status: r.status,
              created_at: r.createdAt,
              delegated,
            });
          }
          return { items };
        }
        if (which === "mine") {
          const items = [];
          for (const r of await mineFor(actor.userId, PORTAL_KINDS, MINE_LIMIT)) {
            items.push({
              id: r.id,
              kind: r.kind,
              subject: r.subject,
              subject_label: await getKind(r.kind)!.subjectLabel(r),
              requester_email: null,
              message: r.message,
              status: r.status,
              created_at: r.createdAt,
              delegated: false,
            });
          }
          return { items };
        }
        return reply.code(400).send({ error: "scope must be mine or inbox" });
      });

      // Always 202 with one fixed body for space.access (see createRequest):
      // the answer does not say whether a Space exists, is private, is open to
      // everyone or is already shared with the caller.
      scope.post("/", async (request, reply) => {
        const body = bodyOf(request);
        const kind = typeof body.kind === "string" ? getKind(body.kind) : undefined;
        if (!kind || !kind.clientCreatable) {
          return reply.code(400).send({ error: "kind must be space.access" });
        }
        if (typeof body.subject !== "string" || body.subject === "" || body.subject.length > SUBJECT_MAX) {
          return reply.code(400).send({ error: "subject is required" });
        }
        const outcome = await createRequest(kind.name, actorOf(request), body.subject, body.message);
        if (outcome === "rate_limited") {
          return reply.code(429).send({ error: "Too many access requests. Try again later." });
        }
        return reply.code(202).send({ accepted: true });
      });

      scope.post<{ Params: { id: string } }>("/:id/approve", async (request, reply) => {
        const result = await decide(actorOf(request), request.params.id, "approve", { kinds: PORTAL_KINDS });
        return result.ok ? { ok: true } : notFound(reply);
      });

      scope.post<{ Params: { id: string } }>("/:id/reject", async (request, reply) => {
        const result = await decide(actorOf(request), request.params.id, "reject", {
          kinds: PORTAL_KINDS,
          note: bodyOf(request).note,
        });
        return result.ok ? { ok: true } : notFound(reply);
      });

      scope.delete<{ Params: { id: string } }>("/:id", async (request, reply) => {
        return (await cancel(actorOf(request), request.params.id, PORTAL_KINDS)) ? { ok: true } : notFound(reply);
      });
    },
    { prefix: "/api/approvals" }
  );
}
