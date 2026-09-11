---
title: Quickstart
description: Run workbench locally, mint an API key, and point an MCP client at it.
---

This gets you from a clone to an agent calling `list_integrations` against your own
server. It takes two secrets, one `.env` file, and one command.

You need Node 20 or 22 (what CI and the Docker image build against) and npm 10.

:::steps

### Clone and install

```bash
git clone https://github.com/barockok/workbench.git
cd workbench
npm install
```

### Generate the two required secrets

Boot fails without these. The config schema is parsed at import time, so a missing
or short value crashes the process before anything else runs.

| Variable | Requirement | Generate with |
|---|---|---|
| `ENCRYPTION_KEY` | exactly 64 hex characters (32 bytes) | `openssl rand -hex 32` |
| `SESSION_SECRET` | at least 32 characters | `openssl rand -base64 32` |

:::tabs
```bash [macOS / Linux]
cp .env.example .env
printf 'ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" >> .env
printf 'SESSION_SECRET=%s\n' "$(openssl rand -base64 32)" >> .env
```
```powershell [Windows]
Copy-Item .env.example .env
$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
"ENCRYPTION_KEY=$(($bytes | ForEach-Object { $_.ToString('x2') }) -join '')" | Add-Content .env
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
"SESSION_SECRET=$([Convert]::ToBase64String($bytes))" | Add-Content .env
```
```bash [Node, any platform]
cp .env.example .env
node -e "const c=require('crypto');console.log('ENCRYPTION_KEY='+c.randomBytes(32).toString('hex'));console.log('SESSION_SECRET='+c.randomBytes(32).toString('base64'))" >> .env
```
:::

`ENCRYPTION_KEY` is the AES-256-GCM key for every stored token and cookie bundle,
read once at module load. Changing it later makes every existing credential
undecryptable and requires a restart.

> [!DANGER] Do not lose or rotate `ENCRYPTION_KEY` casually
> There is no re-encryption path. If you change it, every user has to reconnect
> every integration. Back it up with the same care as the database.

### Set the dev ports

The Vite dev server binds port 3000 with `strictPort`, and proxies `/api` to the
server on 3001. So the server must move off 3000, and `PORTAL_URL` must name the
portal's real origin — it is half of the live-view origin allowlist, and a wrong
value makes browser-session capture fail with a 403.

Append to `.env`:

```bash
cat >> .env <<'EOF'
PORT=3001
PORTAL_URL=http://localhost:3000
SERVER_PUBLIC_URL=http://localhost:3001
EOF
```

### Start the dev servers

```bash
npm run dev
```

This runs the server (`tsx watch`, loading `.env` from the repo root) and the portal
(Vite) together. The portal is at <http://localhost:3000>, the API and `/mcp` at
<http://localhost:3001>.

### Get an API key

The portal has no local password login — it authenticates through Google or
Keycloak SSO. Pick whichever path fits.

> [!WARNING] `.env.example` ships placeholder Google credentials
> It sets `GOOGLE_CLIENT_ID=your-google-oauth-client-id` and a matching secret, and
> the copy above carries them into your `.env`. Any non-empty `GOOGLE_CLIENT_ID`
> makes `/api/auth/providers` advertise `google`, so the portal renders a sign-in
> button that cannot work. If you are not configuring Google, blank both lines.

:::tabs
```bash [No SSO configured]
# Seeds a user and mints an API key directly against the database.
cd packages/server
npx tsx --env-file=../../.env scripts/seed-local-user.ts
# user:    local-dev-user
# api key: 4f3a…
```
```text [Portal with SSO]
1. Set GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (or the three KEYCLOAK_* vars) in .env
   and restart. The Google redirect URI to register is
   ${SERVER_PUBLIC_URL}/api/auth/google/callback
2. Open http://localhost:3000 and sign in.
3. In the API key panel, mint a key and copy it — it is shown once on mint,
   and can be re-revealed later from the same panel.
```
:::

Re-running the seed script for the same user rotates the key. The plaintext is
stored encrypted so the portal can reveal it again. The server also keeps a hash
for lookup.

### Point an MCP client at `/mcp`

The whole MCP surface is `POST /mcp`. Write a `.mcp.json` in your project:

```json
{
  "mcpServers": {
    "workbench": {
      "url": "http://localhost:3001/mcp",
      "headers": { "x-workbench-api-key": "YOUR_API_KEY" }
    }
  }
}
```

> [!WARNING] The API key goes in its own header
> `x-workbench-api-key` is checked first and separately. An API key sent as
> `Authorization: Bearer` will not authenticate — that header is reserved for an
> OAuth access token or a portal session JWT.

### Verify

```bash
export KEY=<the api key from the previous step>

curl -s http://localhost:3001/mcp \
  -H 'content-type: application/json' \
  -H "x-workbench-api-key: $KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

You should get exactly nine tools back: `search_tools`, `get_tool_schema`,
`execute_tools`, `whoami`, `list_integrations`, `connect`, `wait_for_connection`,
`get_auth_url`, `curl_session`. An unauthenticated call returns 401 with a
`WWW-Authenticate` header pointing at the OAuth metadata.

:::

## Next

:::cards 2
- [Connect Claude Code](connect-claude-code.md) — The `.mcp.json` shape, OAuth vs API key, and what breaks.
- [Other MCP clients](connect-other-clients.md) — Transport, token models, OAuth 2.1 discovery.
- [Your first integration](first-connection.md) — Agent-side connect, wait, search, execute.
- [How it works](how-it-works.md) — What just happened, in detail.
:::
