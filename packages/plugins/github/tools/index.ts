import { z } from "zod";

const GH = "https://api.github.com";

function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return s == null ? undefined : String(s);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function firstLine(s: unknown): string {
  return typeof s === "string" ? s.split("\n")[0] : "";
}

// ---------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------

export const listRepos = {
  name: "github_list_repos",
  description:
    "List the authenticated user's GitHub repositories as slim rows { full_name, private, default_branch, updated_at, description, language } — use github_get_repo for full detail on one repo. Defaults: type=all, 30 per page.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    type: z.enum(["all", "owner", "member"]).default("all"),
    perPage: z.number().default(30),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("type", args.type ?? "all");
    params.set("per_page", String(args.perPage ?? 30));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/user/repos?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((r: any) => ({
      full_name: r.full_name,
      private: r.private,
      default_branch: r.default_branch,
      updated_at: r.updated_at,
      description: truncate(r.description, 200),
      language: r.language,
    }));
  },
};

export const getRepo = {
  name: "github_get_repo",
  description:
    "Get one GitHub repository's full metadata (visibility, default branch, topics, counts) with URL bloat stripped — use github_list_repos to discover repo names first.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}`);
    const data = await res.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) return data;
    const out: any = { ...data };
    if (out.owner) out.owner = out.owner.login;
    if (out.organization) out.organization = out.organization.login;
    if (out.license && typeof out.license === "object") out.license = out.license.spdx_id ?? out.license.name;
    if (out.parent?.full_name) out.parent = out.parent.full_name;
    if (out.source?.full_name) out.source = out.source.full_name;
    for (const k of Object.keys(out)) {
      if (k === "html_url" || k === "clone_url") continue;
      if (k === "url" || k.endsWith("_url")) delete out[k];
    }
    delete out.permissions;
    delete out.temp_clone_token;
    return out;
  },
};

export const listBranches = {
  name: "github_list_branches",
  description:
    "List branches in a GitHub repository as slim rows { name, protected }. Defaults: 30 per page. Use github_list_commits to see history on a branch.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    perPage: z.number().default(30),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("per_page", String(args.perPage ?? 30));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/branches?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((b: any) => ({ name: b.name, protected: b.protected }));
  },
};

export const listCommits = {
  name: "github_list_commits",
  description:
    "List commits in a GitHub repository as slim rows { sha (12 chars), message (first line), author, date }, newest first. Pass sha to start from a branch/commit. Defaults: 30 per page.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    sha: z.string().optional(),
    perPage: z.number().default(30),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.sha) params.set("sha", args.sha);
    params.set("per_page", String(args.perPage ?? 30));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/commits?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((c: any) => ({
      sha: typeof c.sha === "string" ? c.sha.slice(0, 12) : c.sha,
      message: firstLine(c.commit?.message),
      author: c.commit?.author?.name ?? c.author?.login,
      date: c.commit?.author?.date,
    }));
  },
};

export const listReleases = {
  name: "github_list_releases",
  description:
    "List releases for a GitHub repository as slim rows { tag_name, name, draft, prerelease, published_at }, newest first. Defaults: 30 per page.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    perPage: z.number().default(30),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("per_page", String(args.perPage ?? 30));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/releases?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((r: any) => ({
      tag_name: r.tag_name,
      name: r.name,
      draft: r.draft,
      prerelease: r.prerelease,
      published_at: r.published_at,
    }));
  },
};

export const getContent = {
  name: "github_get_content",
  description:
    "Read a file (base64 content + sha) or list a directory in a GitHub repo at an optional ref. Returns the file's content/encoding/sha or, for directories, entries with name/path/type/size. Use the returned sha with github_create_or_update_file when updating.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    path: z.string().default(""),
    ref: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("path", args.path);
    if (args.ref) params.set("ref", args.ref);
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/contents/${args.path}?${params}`);
    const data = await res.json();
    const trim = (entry: any) => {
      if (!entry || typeof entry !== "object") return entry;
      const out: any = { ...entry };
      delete out._links;
      delete out.url;
      delete out.git_url;
      return out;
    };
    return Array.isArray(data) ? data.map(trim) : trim(data);
  },
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const createIssue = {
  name: "github_create_issue",
  description:
    "Create a GitHub issue with optional body and labels. Returns the created issue. Follow up with github_update_issue / github_add_issue_comment; use github_list_issues to find existing ones first and avoid duplicates.",
  integration: "github",
  effect: "write",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { title: args.title };
    if (args.body) body.body = args.body;
    if (args.labels) body.labels = args.labels;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

export const listIssues = {
  name: "github_list_issues",
  description:
    "List issues in a GitHub repository as slim rows { number, title, state, author, labels, assignee, comments, updated_at, is_pr }. Note: GitHub's issues list includes PRs — is_pr flags them. Defaults: state=open, 10 per page. Use github_get_issue for one issue's body.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    labels: z.string().optional().describe("Comma-separated label names to filter by"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("state", args.state ?? "open");
    if (args.labels) params.set("labels", args.labels);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/issues?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user?.login,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
      assignee: i.assignee?.login,
      comments: i.comments,
      updated_at: i.updated_at,
      is_pr: Boolean(i.pull_request),
    }));
  },
};

export const getIssue = {
  name: "github_get_issue",
  description:
    "Get one GitHub issue: { number, title, body (truncated to 2000 chars), state, author, labels, assignees, comments, html_url }. Use github_list_pr_comments-style follow-ups via github_add_issue_comment to reply.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}`);
    const i = await res.json();
    if (!i || typeof i !== "object") return i;
    return {
      number: i.number,
      title: i.title,
      body: truncate(i.body, 2000),
      state: i.state,
      author: i.user?.login,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
      assignees: (i.assignees ?? []).map((a: any) => a?.login),
      comments: i.comments,
      html_url: i.html_url,
    };
  },
};

export const updateIssue = {
  name: "github_update_issue",
  description:
    "Update a GitHub issue — set any of title, body, state (open|closed), labels, assignees; only the fields you pass are changed. Closing an issue = state:'closed'. Returns the updated issue's number/state/title.",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.body !== undefined) body.body = args.body;
    if (args.state !== undefined) body.state = args.state;
    if (args.labels !== undefined) body.labels = args.labels;
    if (args.assignees !== undefined) body.assignees = args.assignees;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const i = await res.json();
    if (!i || typeof i !== "object") return i;
    return { number: i.number, title: i.title, state: i.state, html_url: i.html_url };
  },
};

export const addIssueComment = {
  name: "github_add_issue_comment",
  description:
    "Add a comment to a GitHub issue (also works as a PR discussion comment). Returns { id, html_url }. For inline code-review comments on a PR diff, use github_add_pr_comment with type:'review' instead.",
  integration: "github",
  effect: "write",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    issueNumber: z.number(),
    body: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: args.body }),
    });
    const c = await res.json();
    if (!c || typeof c !== "object") return c;
    return { id: c.id, html_url: c.html_url };
  },
};

// ---------------------------------------------------------------------------
// Pull requests
// ---------------------------------------------------------------------------

export const createPR = {
  name: "github_create_pr",
  description:
    "Open a GitHub pull request from head branch into base branch. Returns the created PR. Follow up with github_get_pr / github_get_pr_diff to review it and github_merge_pr to land it.",
  integration: "github",
  effect: "write",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    head: z.string(),
    base: z.string(),
    body: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {
      title: args.title,
      head: args.head,
      base: args.base,
    };
    if (args.body) body.body = args.body;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

export const listPRs = {
  name: "github_list_prs",
  description:
    "List pull requests in a GitHub repository as slim rows { number, title, state, author, head, base, draft, updated_at }. Defaults: state=open, 10 per page. Use github_get_pr for one PR's full detail.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("state", args.state ?? "open");
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((p: any) => ({
      number: p.number,
      title: p.title,
      state: p.state,
      author: p.user?.login,
      head: p.head?.ref,
      base: p.base?.ref,
      draft: p.draft,
      updated_at: p.updated_at,
    }));
  },
};

export const getPR = {
  name: "github_get_pr",
  description:
    "Get one pull request: title, body (truncated to 2000 chars), state, merged/mergeable, author, head/base refs, draft, additions/deletions/changed_files, comment counts, html_url. Use github_get_pr_diff for the actual code changes.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`);
    const p = await res.json();
    if (!p || typeof p !== "object") return p;
    return {
      number: p.number,
      title: p.title,
      body: truncate(p.body, 2000),
      state: p.state,
      merged: p.merged,
      mergeable: p.mergeable,
      author: p.user?.login,
      head: p.head?.ref,
      base: p.base?.ref,
      draft: p.draft,
      additions: p.additions,
      deletions: p.deletions,
      changed_files: p.changed_files,
      comments: p.comments,
      review_comments: p.review_comments,
      html_url: p.html_url,
    };
  },
};

export const getPRDiff = {
  name: "github_get_pr_diff",
  description:
    "Read a pull request's changes. With files:true (recommended first for big PRs) returns a cheap per-file summary { filename, status, additions, deletions }; with files:false (default) returns the full unified diff text, which can be very large. Check changed_files via github_get_pr to decide.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
    files: z
      .boolean()
      .default(false)
      .describe("true = list changed files with add/del counts instead of the raw diff"),
  }),
  handler: async (ctx: any, args: any) => {
    if (args.files) {
      const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/files`);
      const data = await res.json();
      if (!Array.isArray(data)) return data;
      return data.map((f: any) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
      }));
    }
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}`, {
      headers: { Accept: "application/vnd.github.v3.diff" },
    });
    return res.text ? await res.text() : await res.json();
  },
};

export const listPRComments = {
  name: "github_list_pr_comments",
  description:
    "List comments on a pull request as slim rows { id, author, body, path?, line?, created_at }. type:'discussion' (default) = conversation-tab comments; type:'review' = inline code-review comments anchored to file/line.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
    type: z.enum(["review", "discussion"]).default("discussion"),
  }),
  handler: async (ctx: any, args: any) => {
    const type = args.type ?? "discussion";
    const url =
      type === "review"
        ? `${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/comments`
        : `${GH}/repos/${args.owner}/${args.repo}/issues/${args.prNumber}/comments`;
    const res = await ctx.http(url);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((c: any) => ({
      id: c.id,
      author: c.user?.login,
      body: c.body,
      path: c.path,
      line: c.line,
      created_at: c.created_at,
    }));
  },
};

export const addPRComment = {
  name: "github_add_pr_comment",
  description:
    "Comment on a pull request. type:'discussion' (default) posts to the conversation tab and only needs body; type:'review' posts an inline code comment and additionally requires commit_id, path, and line. Returns { id, html_url }. For an approval/request-changes verdict, use github_create_pr_review instead.",
  integration: "github",
  effect: "write",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
    body: z.string(),
    type: z.enum(["review", "discussion"]).default("discussion"),
    commit_id: z.string().optional().describe("Required when type=review: the commit SHA to anchor to"),
    path: z.string().optional().describe("Required when type=review: file path in the diff"),
    line: z.number().optional().describe("Required when type=review: line number in the diff"),
  }),
  handler: async (ctx: any, args: any) => {
    const type = args.type ?? "discussion";
    let url: string;
    let payload: any;
    if (type === "review") {
      if (!args.commit_id || !args.path || args.line == null) {
        throw new Error("type='review' requires commit_id, path, and line");
      }
      url = `${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/comments`;
      payload = { body: args.body, commit_id: args.commit_id, path: args.path, line: args.line };
    } else {
      url = `${GH}/repos/${args.owner}/${args.repo}/issues/${args.prNumber}/comments`;
      payload = { body: args.body };
    }
    const res = await ctx.http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const c = await res.json();
    if (!c || typeof c !== "object") return c;
    return { id: c.id, html_url: c.html_url };
  },
};

export const mergePR = {
  name: "github_merge_pr",
  description:
    "Merge a pull request into its base branch. IRREVERSIBLE — this lands the code; confirm the right PR number first (github_get_pr) and prefer reviewing via github_get_pr_diff before merging. Optional merge_method (merge|squash|rebase) and commit_title.",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
    merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
    commit_title: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {};
    if (args.merge_method) body.merge_method = args.merge_method;
    if (args.commit_title) body.commit_title = args.commit_title;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/merge`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const m = await res.json();
    if (!m || typeof m !== "object") return m;
    return { merged: m.merged, sha: m.sha, message: m.message };
  },
};

export const createPRReview = {
  name: "github_create_pr_review",
  description:
    "Submit a formal review verdict on a pull request: event APPROVE, REQUEST_CHANGES, or COMMENT, with an optional summary body. Returns { id, state }. For a single inline or discussion comment without a verdict, use github_add_pr_comment instead.",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    prNumber: z.number(),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    body: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const payload: any = { event: args.event };
    if (args.body) payload.body = args.body;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/pulls/${args.prNumber}/reviews`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const r = await res.json();
    if (!r || typeof r !== "object") return r;
    return { id: r.id, state: r.state };
  },
};

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

export const createOrUpdateFile = {
  name: "github_create_or_update_file",
  description:
    "Create or update a single file in a GitHub repo with a commit message (content is plain text, base64-encoded automatically). Updating an existing file REQUIRES its current sha — fetch it with github_get_content first or the call fails with 409/422. Defaults: branch=main.",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    message: z.string(),
    content: z.string(),
    sha: z.string().optional(),
    branch: z.string().default("main"),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {
      message: args.message,
      content: Buffer.from(args.content).toString("base64"),
      branch: args.branch,
    };
    if (args.sha) body.sha = args.sha;
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/contents/${args.path}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const searchCode = {
  name: "github_search_code",
  description:
    "Search code across GitHub as slim rows { path, repository, html_url }. Pass full search qualifiers in q (e.g. 'repo:owner/name TODO language:ts') — they are forwarded verbatim. Default 10 results. To read a matched file, follow up with github_get_content.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    q: z.string().describe("Full GitHub code-search query incl. qualifiers like repo:owner/name"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("q", args.q);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/search/code?${params}`);
    const data = await res.json();
    const items = data?.items;
    if (!Array.isArray(items)) return data;
    return items.map((it: any) => ({
      path: it.path,
      repository: it.repository?.full_name,
      html_url: it.html_url,
    }));
  },
};

export const searchIssues = {
  name: "github_search_issues",
  description:
    "Search issues and PRs across GitHub as slim rows { number, title, state, author, labels, comments, updated_at, is_pr, repository }. Pass full qualifiers in q (e.g. 'repo:owner/name is:open label:bug') — forwarded verbatim. Default 10 results. For one known repo's issues, github_list_issues is cheaper.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    q: z.string().describe("Full GitHub issue-search query incl. qualifiers like repo:owner/name is:open"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("q", args.q);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/search/issues?${params}`);
    const data = await res.json();
    const items = data?.items;
    if (!Array.isArray(items)) return data;
    return items.map((i: any) => ({
      number: i.number,
      title: i.title,
      state: i.state,
      author: i.user?.login,
      labels: (i.labels ?? []).map((l: any) => (typeof l === "string" ? l : l?.name)),
      comments: i.comments,
      updated_at: i.updated_at,
      is_pr: Boolean(i.pull_request),
      repository: i.repository?.full_name ?? (typeof i.repository_url === "string" ? i.repository_url.split("/repos/")[1] : undefined),
    }));
  },
};

// ---------------------------------------------------------------------------
// Actions (CI)
// ---------------------------------------------------------------------------

export const listWorkflowRuns = {
  name: "github_list_workflow_runs",
  description:
    "List GitHub Actions workflow runs (CI status) as slim rows { id, name, head_branch, event, status, conclusion, run_started_at, html_url }, newest first. Optional branch and status (e.g. completed, in_progress, failure) filters. Default 10 per page.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    branch: z.string().optional(),
    status: z.string().optional().describe("Filter, e.g. completed | in_progress | queued | success | failure"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.branch) params.set("branch", args.branch);
    if (args.status) params.set("status", args.status);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/actions/runs?${params}`);
    const data = await res.json();
    const runs = data?.workflow_runs;
    if (!Array.isArray(runs)) return data;
    return runs.map((r: any) => ({
      id: r.id,
      name: r.name,
      head_branch: r.head_branch,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      run_started_at: r.run_started_at,
      html_url: r.html_url,
    }));
  },
};

export const triggerWorkflow = {
  name: "github_trigger_workflow",
  description:
    "Trigger a GitHub Actions workflow run via workflow_dispatch. `workflow` is the workflow file name (e.g. ci.yml) or its numeric id; `ref` is the branch or tag to run on. Optional `inputs` maps to the workflow's workflow_dispatch inputs. The workflow file MUST declare `on: workflow_dispatch` or GitHub returns 422. Returns { ok: true } — the dispatch API has no body and returns no run id; poll github_list_workflow_runs (filter by branch/event=workflow_dispatch) to find the created run.",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    workflow: z.string().describe("Workflow file name (ci.yml) or numeric id"),
    ref: z.string().describe("Branch or tag to run the workflow on"),
    inputs: z.record(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { ref: args.ref };
    if (args.inputs) body.inputs = args.inputs;
    const res = await ctx.http(
      `${GH}/repos/${args.owner}/${args.repo}/actions/workflows/${encodeURIComponent(args.workflow)}/dispatches`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    // 204 No Content = success; anything else carries a GitHub error body.
    if (res.status === 204) return { ok: true };
    return { ok: false, status: res.status, error: await res.json().catch(() => res.statusText) };
  },
};

export const getWorkflowRun = {
  name: "github_get_workflow_run",
  description:
    "Get a single GitHub Actions workflow run by id as a slim object { id, name, head_branch, event, status, conclusion, run_started_at, html_url }. Use this to poll a run you triggered with github_trigger_workflow (status: queued | in_progress | completed; conclusion: success | failure | cancelled | …).",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    runId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${GH}/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}`);
    const r = await res.json();
    if (!r || typeof r.id !== "number") return r;
    return {
      id: r.id,
      name: r.name,
      head_branch: r.head_branch,
      event: r.event,
      status: r.status,
      conclusion: r.conclusion,
      run_started_at: r.run_started_at,
      html_url: r.html_url,
    };
  },
};

export const rerunWorkflowRun = {
  name: "github_rerun_workflow_run",
  description:
    "Re-run a GitHub Actions workflow run by id (all jobs). Pass failedOnly to re-run only the failed jobs (rerun-failed-jobs). Returns { ok: true } on success; on failure returns GitHub's { ok:false, status, error } body.",
  integration: "github",
  effect: "write",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    runId: z.number(),
    failedOnly: z.boolean().default(false),
  }),
  handler: async (ctx: any, args: any) => {
    const path = args.failedOnly ? "rerun-failed-jobs" : "rerun";
    const res = await ctx.http(
      `${GH}/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/${path}`,
      { method: "POST" }
    );
    if (res.status === 201) return { ok: true };
    return { ok: false, status: res.status, error: await res.json().catch(() => res.statusText) };
  },
};

export const cancelWorkflowRun = {
  name: "github_cancel_workflow_run",
  description:
    "Cancel an in-progress GitHub Actions workflow run by id. Returns { ok: true } on success; on failure returns GitHub's { ok:false, status, error } body (e.g. 409 if the run already finished).",
  integration: "github",
  effect: "destructive",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
    runId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${GH}/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/cancel`,
      { method: "POST" }
    );
    if (res.status === 202) return { ok: true };
    return { ok: false, status: res.status, error: await res.json().catch(() => res.statusText) };
  },
};

export const getCloneUrl = {
  name: "github_get_clone_url",
  description:
    "Mint a temporary authenticated HTTPS git URL for a repo (https://x-access-token:<token>@github.com/owner/repo.git), usable for clone/pull/push (the granted repo scope covers push). The embedded OAuth token is short-lived and the URL dies with it — re-call this right before a push rather than storing the URL. Do NOT persist it in .git/config or scripts: anyone holding the URL holds the token until expiry.",
  integration: "github",
  effect: "read",
  inputSchema: z.object({
    owner: z.string(),
    repo: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const token = await ctx.getToken();
    return {
      cloneUrl: `https://x-access-token:${token}@github.com/${args.owner}/${args.repo}.git`,
      note: "Token-bearing URL — expires with the OAuth access token. Re-mint before pushing; don't store it.",
    };
  },
};
