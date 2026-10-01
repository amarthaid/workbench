import type { FastifyInstance } from "fastify";
import { adminScope } from "./admin-scope";
import { getInstanceInfo } from "../admin/instance";
import { adminActivity } from "../admin/activity";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    scope.get("/overview/instance", async () => getInstanceInfo());
    scope.get("/overview/activity", async (request, reply) => {
      const result = await adminActivity(request.query as Record<string, string | string[] | undefined>);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return result.page;
    });
  });
}
