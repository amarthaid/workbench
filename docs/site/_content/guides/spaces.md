---
title: Building a Space
description: Write a live web page that calls integrations as whoever opens it, and deploy it from an agent.
---

A Space is a static site with one extra: a small SDK that lets the page call workbench tools as the person viewing it. This guide builds a PR timeline that merges open pull requests from GitHub and Bitbucket, then deploys it. The reference is [Spaces](../integrations/spaces.md).

## The rules

- Load the SDK with `<script src="/s/_sdk/workbench.js"></script>`, exactly that absolute path.
- Get data with `await workbench.call(integration, tool, args)`. The page has no network access: `fetch`, XHR and WebSockets are blocked by `connect-src 'none'`.
- Bundle or inline every asset. Scripts, styles, images and fonts load only from the Space itself (relative URLs like `./app.js` work) or inline; CDNs and web fonts are blocked.
- Declare every tool the page calls in `deploy_space`'s `tools`. Anything else is refused with `TOOL_NOT_DECLARED`.
- Expect the viewer to approve the tool list once, and to confirm every `destructive` call. A denied call rejects with `DENIED`.

## The SDK

```ts
workbench.call(integration: string, tool: string, args?: object): Promise<unknown>
workbench.me(): Promise<{ email: string }>
workbench.store.get(key): Promise<unknown | undefined>
workbench.store.set(key, value): Promise<void>
workbench.store.delete(key): Promise<void>
workbench.store.keys(): Promise<string[]>
```

`tool` is the fully-qualified name (`github_list_prs`) or its bare suffix (`list_prs`). The store is per viewer and per Space: at most 64 KiB per value and 256 KiB in total.

Failures reject with a `WorkbenchError` that has `code`, `message`, `integration` and `tool`. The codes are `TOOL_NOT_DECLARED`, `TOOL_UNAVAILABLE`, `NOT_CONNECTED`, `DENIED`, `INVALID_ARGS`, `UPSTREAM_ERROR`, `RATE_LIMITED`, `UNAUTHENTICATED`, `CONSENT_REQUIRED`, `TOO_LARGE` and `TIMEOUT` (no answer within 120 seconds). Show them in the page: `NOT_CONNECTED` in particular is normal for a viewer who has not connected one of the integrations, and the shell already offers them a Connect link.

## Example: a PR timeline

The page lists open PRs from one GitHub repository (`github_list_prs`) and one Bitbucket repository (`bitbucket_list_prs`), newest first. Each source fails independently, so a viewer without Bitbucket still sees GitHub. The repositories are remembered per viewer in the store.

`index.html`:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>PR timeline</title>
  <style>
    body { font: 14px system-ui, sans-serif; margin: 2rem; max-width: 52rem; }
    li { margin: .4rem 0; }
    .src { font-size: 12px; padding: 0 .4rem; border-radius: 4px; background: #eee; }
    .err { color: #a00; }
  </style>
  <script src="/s/_sdk/workbench.js"></script>
</head>
<body>
  <h1>Open pull requests</h1>
  <form id="repos">
    <input name="gh" placeholder="GitHub owner/repo, e.g. acme/demo-repo">
    <input name="bb" placeholder="Bitbucket workspace/repo, e.g. acme/demo-repo">
    <button>Show</button>
  </form>
  <p id="status"></p>
  <ul id="list"></ul>
  <script>
    const $ = (id) => document.getElementById(id);

    async function github(spec) {
      const [owner, repo] = spec.split("/");
      const rows = await workbench.call("github", "github_list_prs", { owner, repo, state: "open", perPage: 50 });
      return rows.map((p) => ({ src: "GitHub", title: `#${p.number} ${p.title}`, author: p.author, at: p.updated_at }));
    }

    async function bitbucket(spec) {
      const [workspace, repoSlug] = spec.split("/");
      const { prs } = await workbench.call("atlassian-bitbucket", "bitbucket_list_prs", { workspace, repoSlug, state: "OPEN", pagelen: 50 });
      return prs.map((p) => ({ src: "Bitbucket", title: `#${p.id} ${p.title}`, author: p.author, at: p.updated_on }));
    }

    async function load(repos) {
      $("status").textContent = "Loading...";
      const jobs = [];
      if (repos.gh) jobs.push(github(repos.gh));
      if (repos.bb) jobs.push(bitbucket(repos.bb));
      const results = await Promise.allSettled(jobs);
      const rows = results.flatMap((r) => (r.status === "fulfilled" ? r.value : []));
      const errors = results.filter((r) => r.status === "rejected").map((r) => `${r.reason.integration}: ${r.reason.code}`);
      rows.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      $("list").replaceChildren(...rows.map((r) => {
        const li = document.createElement("li");
        li.innerHTML = `<span class="src"></span> <b></b> by <i></i>`;
        li.children[0].textContent = r.src;
        li.children[1].textContent = r.title;
        li.children[2].textContent = r.author ?? "unknown";
        return li;
      }));
      $("status").className = errors.length ? "err" : "";
      $("status").textContent = errors.length ? `Could not load: ${errors.join(", ")}` : `${rows.length} open`;
    }

    $("repos").addEventListener("submit", async (e) => {
      e.preventDefault();
      const repos = { gh: e.target.gh.value.trim(), bb: e.target.bb.value.trim() };
      await workbench.store.set("repos", repos);
      load(repos);
    });

    workbench.store.get("repos").then((repos) => {
      if (!repos) return;
      $("repos").gh.value = repos.gh ?? "";
      $("repos").bb.value = repos.bb ?? "";
      load(repos);
    });
  </script>
</body>
</html>
```

Text from the integrations goes in with `textContent`, never `innerHTML`: a PR title is untrusted input.

The form never submits anywhere (`form-action 'none'`); the handler calls `preventDefault()` and does the work in script.

## Deploy it

Ask your agent, or call the tool yourself:

```json
{ "executions": [ { "tool": "deploy_space", "arguments": {
  "name": "pr-timeline",
  "title": "PR timeline",
  "description": "Open PRs across GitHub and Bitbucket, as you.",
  "tools": ["github_list_prs", "bitbucket_list_prs"],
  "visibility": "org"
} } ] }
```

The result carries `uploadUrl`. Upload the directory holding `index.html`:

```bash
tar czf - -C ./pr-timeline . | curl --data-binary @- \
  -H 'Content-Type: application/gzip' <uploadUrl>
```

Open `url` from the result (`/s/pr-timeline` on the portal). Each viewer approves the two read tools once; neither is `destructive`, so no call asks again.

## Changing it

- Edit a file: `update_space` with `files: true`, then upload only the changed files. Unmentioned files stay.
- Add a tool: `update_space` with the new `tools` list. Every viewer is asked to approve again.
- Share with specific people: `update_space` with `visibility: "users"` and `users: ["dev@example.com"]`.

## Tips

- Use `Promise.allSettled` across integrations so one missing connection does not blank the page.
- Keep calls modest: each viewer gets 60 calls per minute per Space, tool calls and store calls together (`RATE_LIMITED` beyond that).
- Look up exact tool names and argument shapes with `search_tools` and `get_tool_schema` before writing the page; `get_tool_schema` also shows each tool's `effect`.
- `{{vault:...}}` references are refused in a Space's arguments.
