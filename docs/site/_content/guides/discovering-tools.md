---
title: Discovering tools
description: How an agent finds the right tool among hundreds without loading every schema into its context.
---

A stock workbench install loads 16 plugins with 194 tools, plus 12 more from the two
built-in integrations. If the MCP endpoint listed all of them, every conversation would
start by burning tens of thousands of tokens on schemas the agent will never call — and
most clients degrade badly once a tool list gets long.

So `tools/list` returns exactly nine tools, ever. They are the *meta-tools*: a fixed,
small surface through which every plugin tool is reached. Three of them cover discovery.

| Meta-tool | Answers |
|---|---|
| `list_integrations` | Which services exist, and am I connected to them? |
| `search_tools` | Which tools match this keyword? |
| `get_tool_schema` | What arguments does this one tool take? |

The pattern is: narrow by integration or keyword, fetch one schema, then
[execute](executing-tools.md). Nothing loads a schema you did not ask for.

## list_integrations

Takes no arguments. Returns every registered integration and whether the calling user
has a working credential for it.

```json
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"list_integrations","arguments":{}}}
```

```json
{
  "integrations": [
    { "name": "github",   "version": "1.0.0", "connected": true },
    { "name": "gitlab",   "version": "1.0.0", "connected": false },
    { "name": "browser",  "version": "1.0.0", "connected": true },
    { "name": "jots",     "version": "1.0.0", "connected": true }
  ]
}
```

`connected` is computed per auth type, not read from a flag:

| Auth type | `connected` means |
|---|---|
| `none` | always `true` — built-ins like `browser` and `jots` need no credential |
| `cookie` | a stored cookie bundle exists **and** at least one cookie is unexpired |
| everything else | a stored access token exists |

That is the same check `execute_tools` runs before a handler, so a `false` here predicts
a `NOT_CONNECTED` error there.

The MCP response is deliberately thin — `name`, `version`, `connected` only. Display
names, logos, categories and tool counts come from the portal API
(`GET /api/integrations`), not from this tool.

## search_tools

Takes one required `query` string and returns matching tools with their descriptions and
owning integration.

```json
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"search_tools","arguments":{"query":"pull request"}}}
```

```json
{
  "tools": [
    {
      "name": "github_create_pr",
      "description": "Open a GitHub pull request from head branch into base branch. …",
      "integration": "github"
    },
    {
      "name": "github_list_prs",
      "description": "List pull requests in a GitHub repository as slim rows … Defaults: state=open, 10 per page. …",
      "integration": "github"
    },
    {
      "name": "bitbucket_create_pr",
      "description": "Create a Bitbucket pull request from sourceBranch into destinationBranch …",
      "integration": "atlassian-bitbucket"
    }
  ]
}
```

Descriptions come back in full — several shipped tools carry a paragraph explaining
follow-up tools and traps. They are abbreviated here.

### How matching works

The ranking is worth knowing, because it is simpler than most search:

- The query is lowercased once, then each tool is kept if its **name** or its
  **description** contains that string. Plain substring `includes`, no tokenizing.
- There is **no ranking**. Results come back in registry insertion order — roughly plugin
  load order — not by relevance. The first result is not the best result.
- There is no fuzzy matching, no stemming, no synonyms. `"PRs"` does not match
  `"pull request"`. A multi-word query is matched as one literal string, so
  `"create pull"` matches nothing while `"pull request"` matches plenty.
- There is no limit and no pagination. A one-letter query returns nearly everything.

In practice: search for a single distinctive word (`"pipeline"`, `"issue"`, `"upload"`),
or search the integration prefix (`"gitlab_"`) to enumerate one plugin's surface.

> [!NOTE] Tool names are one flat namespace
> The registry keys tools by name across all plugins, and a later-loaded plugin
> silently overwrites an earlier one with the same tool name. That is why every shipped
> plugin prefixes its tools with its own slug (`github_`, `jira_`, `slack_`).

## get_tool_schema

Takes one required `tool` name and returns that tool's argument schema.

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"get_tool_schema","arguments":{"tool":"github_list_prs"}}}
```

```json
{
  "schema": {
    "type": "object",
    "properties": {
      "owner":   { "type": "string" },
      "repo":    { "type": "string" },
      "state":   { "type": "string", "enum": ["open", "closed", "all"], "default": "open" },
      "perPage": { "type": "number", "default": 10 },
      "page":    { "type": "number", "default": 1 }
    },
    "required": ["owner", "repo"],
    "additionalProperties": false,
    "$schema": "http://json-schema.org/draft-07/schema#"
  }
}
```

Plugins define their schemas in Zod. This tool converts them to portable JSON Schema so
a client needs no Zod knowledge. Defaults survive the conversion, and they are real —
`execute_tools` validates against the same Zod schema before calling the handler, so an
omitted `state` genuinely arrives as `"open"` rather than `undefined`.

An unknown name returns `{"error": "Tool not found"}` — a successful JSON-RPC result
containing an error object, not a protocol error.

## The 60,000-character cap

Every `tools/call` result is JSON-stringified into a single text block and capped at
**60,000 characters**. Past that, the text is truncated and a notice is appended:

```
…[result truncated: 214883 chars total, showing first 60000. Narrow the request (limit/fields/pagination) to get complete data.]
```

This exists because plugin handlers mostly pass upstream API responses through
untouched, and one unbounded list call can otherwise blow out the caller's context
window.

> [!WARNING] Truncated output is not valid JSON
> The cap slices the string mid-structure on purpose. Do not try to repair or re-parse
> it — treat the notice as an instruction and reissue the call with a `limit`, a field
> selection, or pagination.

The cap applies to discovery too. A `search_tools` query broad enough to match most of
the catalog can hit it. One exception: if a result carries an `_mcpImage` sentinel
(a screenshot, say), the content becomes image blocks instead and the text block is
dropped entirely.

## Putting it together

```mermaid
sequenceDiagram
    participant A as Agent
    participant W as workbench /mcp
    A->>W: tools/list
    W-->>A: 9 meta-tools only
    A->>W: list_integrations
    W-->>A: github connected, gitlab not
    A->>W: search_tools "pull request"
    W-->>A: github_create_pr, github_list_prs, …
    A->>W: get_tool_schema github_create_pr
    W-->>A: JSON Schema
    A->>W: execute_tools [{tool, args}]
    W-->>A: results
```

Next: [Executing tools](executing-tools.md) covers the batch call, the per-execution
lifecycle, and the exact error shapes.
