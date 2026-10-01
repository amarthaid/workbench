# Admin gate accepts the session only

`users.is_admin` existed since the first schema and nothing read it. The admin
area derives admin from `ADMIN_EMAILS` instead.

- `authenticate()` in `api/routes.ts` accepts the API key header as well as the
  session JWT. Reusing it for `/api/admin/*` would let an admin's MCP key act as
  admin, so `resolveAdmin` verifies the session JWT directly.
- The email is compared from `users.email`, not the JWT claim.
- The gate is a Fastify `preHandler` hook on an encapsulated `/api/admin` scope,
  so a route added to it cannot omit the check.
- `parseAdminEmails` drops empty entries: `ADMIN_EMAILS=","` must not match a
  user whose email is null.
- Suites that mock `../src/config` have no `ADMIN_EMAILS`; readers tolerate
  `undefined`.
- Portal tests must run through `npm run test`: the script sets
  `NODE_OPTIONS=--no-experimental-webstorage`, and a bare `npx vitest run` on
  Node 25 fails `ThemeToggle` and `CdpScreencast` for an unrelated reason.
