import type { FastifyInstance } from "fastify";
import { adminScope } from "./admin-scope";
import { getInstanceInfo } from "../admin/instance";

export async function registerAdminRoutes(app: FastifyInstance): Promise<void> {
  await adminScope(app, (scope) => {
    scope.get("/overview/instance", async () => getInstanceInfo());
  });
}
