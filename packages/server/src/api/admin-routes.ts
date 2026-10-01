import type { FastifyInstance } from "fastify";
import { adminScope } from "./admin-scope";
import { getInstanceInfo } from "../admin/instance";
import { adminActivity } from "../admin/activity";
import { getConnectionStats } from "../admin/connections";
import { listAllCustomApps } from "../admin/custom-apps";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    scope.get("/overview/instance", async () => getInstanceInfo());
    scope.get("/overview/activity", async (request, reply) => {
      const result = await adminActivity(request.query as Record<string, string | string[] | undefined>);
      if (!result.ok) return reply.status(400).send({ error: result.error });
      return result.page;
    });
    scope.get("/overview/connections", async () => getConnectionStats());
    scope.get("/overview/custom-apps", async () => listAllCustomApps());
  });
}
