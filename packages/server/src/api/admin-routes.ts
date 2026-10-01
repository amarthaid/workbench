import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { db } from "../db";
import { activeProfiles, profileDirName, profilesBaseDir } from "../auth/profile-chromium";
import { adminScope } from "./admin-scope";
import { getInstanceInfo } from "../admin/instance";
import { adminActivity } from "../admin/activity";
import { getConnectionStats } from "../admin/connections";
import { listAllCustomApps } from "../admin/custom-apps";
import { listBrowserProfiles } from "../admin/profiles";

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
    scope.get("/overview/browser-profiles", async () => {
      const base = profilesBaseDir();
      const users = await db.all<{ id: string; email: string | null }>("SELECT id, email FROM users");
      const emailByDirName = new Map(users.map((u) => [profileDirName(u.id), u.email ?? null]));
      const profiles = await listBrowserProfiles({
        baseDir: base,
        activeDirs: [...activeProfiles].map((userId) => join(base, profileDirName(userId))),
        emailByDirName,
      });
      // Cluster workers share one profiles volume, so this is the whole list.
      // Which profiles are live comes from the use-marker window, not from
      // this process's own handles.
      return { profiles };
    });
  });
}
