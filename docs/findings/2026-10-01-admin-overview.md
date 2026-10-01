# Admin overview

- The Docker image shipped no `package.json`, and `custom-apps/client.ts` resolved
  `../../../../package.json` (`/package.json` inside the image), so every
  container reported version `0.0.0`, including to custom MCP servers. The layout
  differs: a checkout has the root three levels above `src/`, the image has the
  flattened server at `/app/server` with `package.json` one level up. `readVersion`
  tries both, root first, because from `src/` the one-level-up file is
  `packages/server/package.json`, whose version is stale. The Dockerfile now
  copies the root `package.json`.
- `connections` records no refresh failure, so "needs reconnect" is derived:
  expired `expires_at` and a null `refresh_token`. Cookie and API-key connections
  have a null `expires_at` and never count. Real failure tracking needs DDL.
- Cross-user activity is `audit_log LEFT JOIN users`, so an event whose user row
  is gone still shows, with a null email. Keyset paging stays the longhand
  `created_at < ? OR (created_at = ? AND id < ?)`.
- Each card has its own endpoint and its own component state, so a slow disk walk
  in the profiles card cannot blank the activity card.
- Gate tests import `api/admin-scope.ts`, which has no database import, because
  the gate suite mocks `config` with a hand-built object and the DB opens a file
  from `config.DATABASE_URL` at import time.
- A profile directory with no use-marker files falls back to the directory's own
  mtime, as the reaper does, so a just-created empty profile reads as live: that
  protects a chromium that has started but not yet written its markers.
- In the portal tests, a persistent `mockRejectedValue` on a query's fetch fails
  the test with an unhandled `Error: boom` even though the query function runs
  once and the component shows its error state. `mockRejectedValueOnce` does not.
  Cause not fully explained; the repo's `Home.test.tsx` already uses the `Once`
  form for a query.
