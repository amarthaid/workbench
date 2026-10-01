import type { FastifyInstance } from "fastify";
import { resolveAdmin } from "../auth/admin";

type ScopeSetup = (scope: FastifyInstance) => Promise<void> | void;

// Everything under /api/admin lives in one encapsulated scope whose onRequest
// hook runs the gate. A route registered inside it cannot forget to check:
// there is no per-route opt-in to miss.
export async function adminScope(app: FastifyInstance, setup: ScopeSetup): Promise<void> {
  await app.register(
    async (scope) => {
      scope.addHook("onRequest", async (request, reply) => {
        const admin = await resolveAdmin(request);
        if (!admin.ok) {
          return reply
            .status(admin.status)
            .send({ error: admin.status === 401 ? "Unauthorized" : "Forbidden" });
        }
      });
      await setup(scope);
    },
    { prefix: "/api/admin" }
  );
}

// Test seam: lets a test add a route to a fresh gated scope.
export const adminScopeForTest = adminScope;

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    // Placeholder the sub-project 2 endpoints replace. It exists so the gate has
    // a guarded route to exercise end to end.
    scope.get("/ping", async () => ({ ok: true }));
  });
}
