# Scrubbing a tool result as JSON text leaks the value it was meant to hide

**Date:** 2026-09-16
**Area:** `packages/server/src/vault/interpolate.ts`, `packages/server/src/mcp/meta-tools.ts`

## The job

When a tool call substitutes `{{vault:NAME}}` with a real value, the result has
to have the reference put back before it re-enters the model. The first
implementation did the obvious thing: `JSON.stringify` the result, regex the
value out of that text, `JSON.parse` it back.

```ts
const text = JSON.stringify(result);
const scrubbed = text.replace(new RegExp(escapeRe(value), "g"), `{{vault:${name}}}`);
try { return JSON.parse(scrubbed); } catch { return value; }
```

It is wrong in three ways, and the third is the one that leaks.

## What went wrong

**1. The text of a JSON document does not tell you where a value sits.** A
secret that happens to look like a JSON scalar — a port number `5432`, `true`,
`null` — matches wherever those characters appear. Substituting a quoted
placeholder for an unquoted scalar produced `{"port":{{vault:db_port}}}`, which
is not JSON.

**2. A short value matches inside a longer one.** `5432` is a substring of
`154321`, of a timestamp, of an id. The regex replaced it there too and
corrupted unrelated output.

**3. The fallback returned the plaintext.** Worst case in practice: a secret
echoed back inside a sentence rather than as a value — `"connect failed on
5432"` — got a placeholder injected mid-string. That case parses; the scalar
case does not, `JSON.parse` threw, and `catch { return value }` handed back the
**unscrubbed** result. The one code path whose entire purpose is to stop a
plaintext value reaching the model returned the plaintext value, silently,
exactly when scrubbing had failed.

## The fix

Walk the structure, never the text. `scrubVaultValues` JSON-normalises the
value once (`JSON.parse(JSON.stringify(v))`, to collapse `toJSON`, `Date`, and
class instances into plain data) and then `scrubJson` recurses over that:

- **strings** go through `scrubString` (substring replacement is correct
  *inside* a string, which is the only place it is correct);
- **scalar leaves** — number, boolean, null — match only on strict
  `String(leaf) === value`, so `5432` is replaced when it *is* the value and
  never when it is part of `154321`;
- **object keys** are scrubbed too, because a tool can return a value as a key;
- there is no parse step after the walk, so nothing can throw at the end.

And there is no fallback. If the result cannot be JSON-normalised at all — a
`BigInt`, a cycle — `scrubVaultValues` throws `VaultScrubError` and
`executeSingle` turns it into `{ "error": "VAULT_SCRUB_FAILED" }`. Fail closed:
a tool call that returns nothing is a bug report; a tool call that returns the
password is a breach. The failure is logged and counted like any other failed
execution so it is visible in metrics, not only in the model's context.

## The residual limit

Structural matching compares the value as the *tool* rendered it, and a tool
can render it differently from how it was stored. A numeric-looking secret that
a schema coerces — `z.coerce.number()` turning `"5432.0"` into `5432` — comes
back as a number whose `String()` is `5432`, which is not the stored `"5432.0"`,
so it is not caught. Same class of gap as the encoding limits already
documented: base64, URL-escaping, a value split across DOM nodes.

At the time this was written, scrubbing was also same-call-only: a value
substituted in call N and echoed by an unrelated call N+1 (`browser_read_text`
after a `browser_type`, `files_read` after a `files_write`) substituted
nothing in that later call and so scrubbed nothing. `packages/server/src/vault/recent.ts`
closes that: a short-window, per-user, in-process ring remembers what was
substituted recently and scrubs it from every later result too, not just the
one that did the substituting. The residual limits are now the encodings and
canonicalisation gap above, plus the window itself and, under
`CLUSTER_ENABLED`, a result served by a worker other than the one that
remembered the value (`docs/findings/2026-09-10-browser-session-pod-affinity.md`).

Scrubbing is containment for the common case. It is not a guarantee, and the
docs say so.
