import type { FastifyInstance } from "fastify";
import { resolveAdmin } from "../auth/admin";

type ScopeSetup = (scope: FastifyInstance) => Promise<void> | void;

export interface AdminActor {
  userId: string;
  email: string;
}

// Who the gate let in, keyed by the request. A handler needs the actor to
// refuse "disable yourself" and to attribute its audit row.
const actors = new WeakMap<object, AdminActor>();

export function adminActor(request: object): AdminActor {
  const actor = actors.get(request);
  if (!actor) throw new Error("adminActor called outside the admin scope");
  return actor;
}

// Everything under /api/admin lives in one encapsulated scope whose hook runs
// the gate. A route registered inside it cannot forget to check: there is no
// per-route opt-in to miss.
//
// preHandler, not onRequest: every onRequest hook, including root ones added
// after this scope (the HTTP metrics timer), runs before any preHandler. An
// onRequest gate that replies would short-circuit those, and rejected admin
// requests would drop out of the metrics.
//
// Kept apart from admin-routes.ts so gate tests do not import the database.
export async function adminScope(app: FastifyInstance, setup: ScopeSetup): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook("preHandler", async (request, reply) => {
        const admin = await resolveAdmin(request);
        if (!admin.ok) {
          return reply
            .status(admin.status)
            .send({ error: admin.status === 401 ? "Unauthorized" : "Forbidden" });
        }
        actors.set(request, { userId: admin.userId, email: admin.email });
      });
      await setup(scope);
    },
    { prefix: "/api/admin" }
  );
}
