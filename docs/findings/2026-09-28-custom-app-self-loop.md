# A custom app could point back at workbench and loop

**Symptom.** Adding this workbench's own `/mcp` as a custom app was accepted.
The SSRF guard blocks loopback in production, but the public URL
(`SERVER_PUBLIC_URL/mcp`) is not private, so registration, OAuth and tool
discovery all went through. The app's tools are then workbench's own
meta-tools, including `execute_tools`, so an agent could call workbench
through itself with no end. The same happens across two deployments: A has
a custom app pointing at B, and B has one pointing back at A.

**Why the URL is not enough.** Comparing the typed URL with
`SERVER_PUBLIC_URL` misses a second hostname, a CNAME, a bare IP, or a
sibling replica, and it cannot see a loop that goes through another
deployment. The guard uses what the server *says it is*, and what the
request *has already passed through*.

**Fix.** Two layers, in `packages/server/src/custom-apps/loop-guard.ts`:

- **At create time.** `discoverMetadata` already reads the target's
  protected-resource metadata. Workbench serves its own as
  `resource: ${SERVER_PUBLIC_URL}/mcp` under any hostname it is reached by.
  When the discovered `resource` is this instance's `/mcp`,
  `POST /api/custom-apps` fails with a 400 that says it is this workbench's
  own endpoint.
- **At call time.** Every outbound custom-app request carries
  `X-Workbench-Via`: the chain of instance ids it has passed through. The
  id is `HMAC(SESSION_SECRET, "workbench-instance-id")`, cut to 16 hex, so
  every replica of one deployment shares it and the secret stays in the
  process. `/mcp` answers `508 Loop Detected`, with a JSON-RPC error body,
  when the chain already holds this instance's id or has reached
  `MAX_HOPS` (4). Before a request runs, `/mcp` stores its inbound chain in
  an `AsyncLocalStorage`. The chain is read when each outbound request is
  made, not when the connection opens. A custom-app session is cached and
  reused by later `/mcp` requests, which carry different chains.

The call-time layer also covers apps registered before this fix.

**Test gotcha.** `beforeEach(() => mock.mockReset())` returns the mock,
and vitest runs a function returned from `beforeEach` as the teardown. The
mock was then called once more with no arguments after each test and threw.
Use a block body.
