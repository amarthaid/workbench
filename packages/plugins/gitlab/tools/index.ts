import { z } from "zod";

// GitLab works against both gitlab.com and self-hosted instances. The instance
// origin is chosen at connect time and read back via ctx.getConfig().instanceUrl;
// every call builds its API base from it. ctx.http injects the Bearer token.
const DEFAULT_ORIGIN = "https://gitlab.com";

function origin(ctx: any): string {
  const u = ctx.getConfig?.()?.instanceUrl;
  return typeof u === "string" && u ? u.replace(/\/+$/, "") : DEFAULT_ORIGIN;
}

function apiBase(ctx: any): string {
  return `${origin(ctx)}/api/v4`;
}

// A GitLab project is addressed either by numeric id or by URL-encoded
// "namespace/path" (slashes encoded). encodeURIComponent handles both.
function pid(project: string | number): string {
  return encodeURIComponent(String(project));
}

function truncate(s: unknown, max: number): string | undefined {
  if (typeof s !== "string") return s == null ? undefined : String(s);
  return s.length > max ? s.slice(0, max) + "…" : s;
}

function firstLine(s: unknown): string {
  return typeof s === "string" ? s.split("\n")[0] : "";
}

async function readText(res: any): Promise<string> {
  const text = res.text ? await res.text() : await res.json();
  return typeof text === "string" ? text : JSON.stringify(text);
}

const INTEGRATION = "gitlab";

// ---------------------------------------------------------------------------
// Projects (repositories)
// ---------------------------------------------------------------------------

export const listProjects = {
  name: "gitlab_list_projects",
  description:
    "List the authenticated user's GitLab projects as slim rows { id, path_with_namespace, visibility, default_branch, last_activity_at, description }. Pass `search` to filter by name. Use the id or path_with_namespace as `project` in other tools. Defaults: membership projects, 20 per page, ordered by last activity.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    search: z.string().optional(),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("membership", "true");
    params.set("simple", "true");
    params.set("order_by", "last_activity_at");
    if (args.search) params.set("search", args.search);
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((p: any) => ({
      id: p.id,
      path_with_namespace: p.path_with_namespace,
      visibility: p.visibility,
      default_branch: p.default_branch,
      last_activity_at: p.last_activity_at,
      description: truncate(p.description, 200),
    }));
  },
};

export const getProject = {
  name: "gitlab_get_project",
  description:
    "Get one GitLab project's metadata (visibility, default branch, topics, star/fork counts, http clone URL) with link bloat stripped. Use gitlab_list_projects to discover the id or path_with_namespace first.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string().describe("Project id or URL path, e.g. 'group/repo'"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}`);
    const p = await res.json();
    if (!p || typeof p !== "object" || Array.isArray(p)) return p;
    return {
      id: p.id,
      path_with_namespace: p.path_with_namespace,
      name: p.name,
      visibility: p.visibility,
      default_branch: p.default_branch,
      topics: p.topics ?? p.tag_list,
      star_count: p.star_count,
      forks_count: p.forks_count,
      open_issues_count: p.open_issues_count,
      last_activity_at: p.last_activity_at,
      description: truncate(p.description, 500),
      web_url: p.web_url,
      http_url_to_repo: p.http_url_to_repo,
    };
  },
};

export const listBranches = {
  name: "gitlab_list_branches",
  description:
    "List branches in a GitLab project as slim rows { name, default, protected, merged }. Use gitlab_list_commits to see history on a branch. Defaults: 20 per page.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/repository/branches?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((b: any) => ({
      name: b.name,
      default: b.default,
      protected: b.protected,
      merged: b.merged,
    }));
  },
};

export const listCommits = {
  name: "gitlab_list_commits",
  description:
    "List commits in a GitLab project as slim rows { id (12 chars), title, author, date }, newest first. Pass `ref` to start from a branch/tag/commit. Defaults: 20 per page.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    ref: z.string().optional().describe("Branch, tag, or commit SHA to list from"),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.ref) params.set("ref_name", args.ref);
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/repository/commits?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((c: any) => ({
      id: typeof c.id === "string" ? c.id.slice(0, 12) : c.id,
      title: c.title,
      author: c.author_name,
      date: c.committed_date ?? c.created_at,
    }));
  },
};

export const listReleases = {
  name: "gitlab_list_releases",
  description:
    "List releases for a GitLab project as slim rows { tag_name, name, released_at, upcoming }, newest first. Defaults: 20 per page.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/releases?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((r: any) => ({
      tag_name: r.tag_name,
      name: r.name,
      released_at: r.released_at,
      upcoming: r.upcoming_release,
    }));
  },
};

export const getFile = {
  name: "gitlab_get_file",
  description:
    "Read a file's raw text content from a GitLab project at a ref (branch/tag/commit). `ref` is required. Useful for seeing code an MR diff doesn't show. Returns the file contents as plain text.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    path: z.string().describe("File path within the repository"),
    ref: z.string().describe("Branch name, tag, or commit SHA"),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("ref", args.ref);
    const filePath = encodeURIComponent(args.path);
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/repository/files/${filePath}/raw?${params}`
    );
    return readText(res);
  },
};

export const createOrUpdateFile = {
  name: "gitlab_create_or_update_file",
  description:
    "Create or update a single file in a GitLab project with a commit message (content is plain text). Auto-detects create vs update by checking whether the file already exists on `branch`. Defaults: branch=main.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    path: z.string(),
    content: z.string(),
    message: z.string(),
    branch: z.string().default("main"),
  }),
  handler: async (ctx: any, args: any) => {
    const branch = args.branch ?? "main";
    const filePath = encodeURIComponent(args.path);
    const url = `${apiBase(ctx)}/projects/${pid(args.project)}/repository/files/${filePath}`;
    // GitLab uses POST to create and PUT to update; probe existence first.
    const head = await ctx.http(`${url}?ref=${encodeURIComponent(branch)}`);
    const method = head.status === 200 ? "PUT" : "POST";
    const res = await ctx.http(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        branch,
        content: args.content,
        commit_message: args.message,
      }),
    });
    const data = await res.json();
    return { file_path: data.file_path, branch: data.branch, action: method === "PUT" ? "updated" : "created" };
  },
};

// ---------------------------------------------------------------------------
// Issues
// ---------------------------------------------------------------------------

export const createIssue = {
  name: "gitlab_create_issue",
  description:
    "Create a GitLab issue with optional description and labels. Returns the created issue (note its `iid` — the per-project number used by other issue tools). Use gitlab_list_issues first to avoid duplicates.",
  integration: INTEGRATION,
  effect: "write",
  inputSchema: z.object({
    project: z.string(),
    title: z.string(),
    description: z.string().optional(),
    labels: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { title: args.title };
    if (args.description) body.description = args.description;
    if (args.labels) body.labels = args.labels.join(",");
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const i = await res.json();
    if (!i || typeof i !== "object") return i;
    return { iid: i.iid, title: i.title, state: i.state, web_url: i.web_url };
  },
};

export const listIssues = {
  name: "gitlab_list_issues",
  description:
    "List issues in a GitLab project as slim rows { iid, title, state, author, labels, assignees, user_notes_count, updated_at }. Defaults: state=opened, 20 per page. Use gitlab_get_issue for one issue's full description.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    state: z.enum(["opened", "closed", "all"]).default("opened"),
    labels: z.string().optional().describe("Comma-separated label names to filter by"),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if ((args.state ?? "opened") !== "all") params.set("state", args.state ?? "opened");
    if (args.labels) params.set("labels", args.labels);
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/issues?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((i: any) => ({
      iid: i.iid,
      title: i.title,
      state: i.state,
      author: i.author?.username,
      labels: i.labels ?? [],
      assignees: (i.assignees ?? []).map((a: any) => a?.username),
      user_notes_count: i.user_notes_count,
      updated_at: i.updated_at,
    }));
  },
};

export const getIssue = {
  name: "gitlab_get_issue",
  description:
    "Get one GitLab issue: { iid, title, description (truncated to 2000 chars), state, author, labels, assignees, user_notes_count, web_url }. Reply with gitlab_add_issue_comment.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    issueIid: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/issues/${args.issueIid}`);
    const i = await res.json();
    if (!i || typeof i !== "object") return i;
    return {
      iid: i.iid,
      title: i.title,
      description: truncate(i.description, 2000),
      state: i.state,
      author: i.author?.username,
      labels: i.labels ?? [],
      assignees: (i.assignees ?? []).map((a: any) => a?.username),
      user_notes_count: i.user_notes_count,
      web_url: i.web_url,
    };
  },
};

export const updateIssue = {
  name: "gitlab_update_issue",
  description:
    "Update a GitLab issue — set any of title, description, labels, and close/reopen it. Pass state='closed' to close or state='opened' to reopen. Only fields you pass change. Returns the updated issue's iid/state/title.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    issueIid: z.number(),
    title: z.string().optional(),
    description: z.string().optional(),
    state: z.enum(["opened", "closed"]).optional().describe("closed = close the issue, opened = reopen"),
    labels: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {};
    if (args.title !== undefined) body.title = args.title;
    if (args.description !== undefined) body.description = args.description;
    if (args.labels !== undefined) body.labels = args.labels.join(",");
    if (args.state !== undefined) body.state_event = args.state === "closed" ? "close" : "reopen";
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/issues/${args.issueIid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const i = await res.json();
    if (!i || typeof i !== "object") return i;
    return { iid: i.iid, title: i.title, state: i.state, web_url: i.web_url };
  },
};

export const addIssueComment = {
  name: "gitlab_add_issue_comment",
  description:
    "Add a comment (note) to a GitLab issue. Returns { id, created_at }. Use gitlab_get_issue to read the issue first.",
  integration: INTEGRATION,
  effect: "write",
  inputSchema: z.object({
    project: z.string(),
    issueIid: z.number(),
    body: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/issues/${args.issueIid}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: args.body }),
    });
    const c = await res.json();
    if (!c || typeof c !== "object") return c;
    return { id: c.id, created_at: c.created_at };
  },
};

// ---------------------------------------------------------------------------
// Merge requests (the GitLab equivalent of pull requests)
// ---------------------------------------------------------------------------

export const createMR = {
  name: "gitlab_create_mr",
  description:
    "Open a GitLab merge request from sourceBranch into targetBranch (default 'main' — confirm with gitlab_get_project if unsure). Returns the new MR's iid, state, branches, and web URL. Follow up with gitlab_get_mr / gitlab_get_mr_diff to review and gitlab_merge_mr to land it.",
  integration: INTEGRATION,
  effect: "write",
  inputSchema: z.object({
    project: z.string(),
    title: z.string(),
    sourceBranch: z.string(),
    targetBranch: z.string().default("main"),
    description: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {
      title: args.title,
      source_branch: args.sourceBranch,
      target_branch: args.targetBranch ?? "main",
    };
    if (args.description) body.description = args.description;
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const m = await res.json();
    if (!m || typeof m !== "object") return m;
    return {
      iid: m.iid,
      title: m.title,
      state: m.state,
      source_branch: m.source_branch,
      target_branch: m.target_branch,
      web_url: m.web_url,
    };
  },
};

export const listMRs = {
  name: "gitlab_list_mrs",
  description:
    "List merge requests in a GitLab project as slim rows { iid, title, state, author, source_branch, target_branch, draft, updated_at }. state defaults to opened; pass merged/closed/all for history. Use gitlab_get_mr for full detail. Defaults: 20 per page.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    state: z.enum(["opened", "closed", "merged", "all"]).default("opened"),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if ((args.state ?? "opened") !== "all") params.set("state", args.state ?? "opened");
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((m: any) => ({
      iid: m.iid,
      title: m.title,
      state: m.state,
      author: m.author?.username,
      source_branch: m.source_branch,
      target_branch: m.target_branch,
      draft: m.draft ?? m.work_in_progress,
      updated_at: m.updated_at,
    }));
  },
};

export const getMR = {
  name: "gitlab_get_mr",
  description:
    "Get one merge request: iid, title, description (truncated to 2000 chars), state, merge_status, author, source/target branches, draft, upvotes/downvotes, user_notes_count, web_url. Check this (state, merge_status, approvals) before gitlab_merge_mr. For the code changes use gitlab_get_mr_diff.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}`);
    const m = await res.json();
    if (!m || typeof m !== "object") return m;
    return {
      iid: m.iid,
      title: m.title,
      description: truncate(m.description, 2000),
      state: m.state,
      merge_status: m.detailed_merge_status ?? m.merge_status,
      author: m.author?.username,
      source_branch: m.source_branch,
      target_branch: m.target_branch,
      draft: m.draft ?? m.work_in_progress,
      upvotes: m.upvotes,
      downvotes: m.downvotes,
      user_notes_count: m.user_notes_count,
      web_url: m.web_url,
    };
  },
};

export const getMRDiff = {
  name: "gitlab_get_mr_diff",
  description:
    "Read a merge request's changes. With diffstat=true (recommended first for big MRs) returns one slim row per file { old_path, new_path, new_file, deleted_file, renamed_file }; with diffstat=false (default) returns the full unified diff text, which can be large.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
    diffstat: z
      .boolean()
      .default(false)
      .describe("true = per-file summary rows (cheap); false = full unified diff text"),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}/changes`
    );
    const data = await res.json();
    const changes = data?.changes;
    if (!Array.isArray(changes)) return data;
    if (args.diffstat) {
      return {
        files: changes.map((c: any) => ({
          old_path: c.old_path,
          new_path: c.new_path,
          new_file: c.new_file,
          deleted_file: c.deleted_file,
          renamed_file: c.renamed_file,
        })),
      };
    }
    return changes
      .map((c: any) => `diff --git a/${c.old_path} b/${c.new_path}\n${c.diff ?? ""}`)
      .join("\n");
  },
};

export const listMRCommits = {
  name: "gitlab_list_mr_commits",
  description:
    "List the commits in a merge request as slim rows { id (12 chars), title, author, date }. Cheaper than the diff for understanding an MR's shape.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}/commits`
    );
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((c: any) => ({
      id: typeof c.id === "string" ? c.id.slice(0, 12) : c.id,
      title: c.title,
      author: c.author_name,
      date: c.committed_date ?? c.created_at,
    }));
  },
};

export const listMRComments = {
  name: "gitlab_list_mr_comments",
  description:
    "List comments (notes) on a merge request as slim rows { id, author, body, system, resolvable, created_at }. system notes are GitLab's auto-events (label changes etc.). Defaults: 20 per page. Use before replying with gitlab_add_mr_comment.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}/notes?${params}`
    );
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((c: any) => ({
      id: c.id,
      author: c.author?.username,
      body: c.body,
      system: c.system,
      resolvable: c.resolvable,
      created_at: c.created_at,
    }));
  },
};

export const addMRComment = {
  name: "gitlab_add_mr_comment",
  description:
    "Comment on a merge request. Plain `body` posts a general note. Also pass `inline` { path, line } to anchor it to a line of a changed file as a review discussion (paths from gitlab_get_mr_diff); the diff refs are resolved automatically. Returns { id }.",
  integration: INTEGRATION,
  effect: "write",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
    body: z.string(),
    inline: z
      .object({
        path: z.string().describe("File path within the MR diff"),
        line: z.number().describe("Line number in the new version of the file"),
      })
      .optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const base = `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}`;
    if (!args.inline) {
      const res = await ctx.http(`${base}/notes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body: args.body }),
      });
      const c = await res.json();
      return { id: c.id, created_at: c.created_at };
    }
    // Inline review comment: needs the MR's diff_refs (base/head/start SHAs).
    const mrRes = await ctx.http(base);
    const mr = await mrRes.json();
    const refs = mr?.diff_refs;
    if (!refs) throw new Error("Could not resolve MR diff_refs for an inline comment");
    const res = await ctx.http(`${base}/discussions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        body: args.body,
        position: {
          position_type: "text",
          base_sha: refs.base_sha,
          head_sha: refs.head_sha,
          start_sha: refs.start_sha,
          new_path: args.inline.path,
          old_path: args.inline.path,
          new_line: args.inline.line,
        },
      }),
    });
    const d = await res.json();
    return { id: d.id, individual_note: d.individual_note };
  },
};

export const approveMR = {
  name: "gitlab_approve_mr",
  description:
    "Approve a merge request as the connected user. Non-destructive and revocable. Review the changes with gitlab_get_mr_diff first. Returns { approved: true, approvals_left }. (Approvals are a GitLab Premium feature on some instances; on those this 404s.)",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}/approve`,
      { method: "POST" }
    );
    const d = await res.json();
    if (d && typeof d === "object" && "message" in d) return d;
    return { approved: true, approvals_left: d?.approvals_left };
  },
};

export const mergeMR = {
  name: "gitlab_merge_mr",
  description:
    "Merge a merge request into its target branch. IRREVERSIBLE: this lands the commits — check state and merge_status with gitlab_get_mr first, and only merge when explicitly asked. Optional: merge_commit_message, squash, remove_source_branch. Returns the merged MR's iid and state.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
    merge_commit_message: z.string().optional(),
    squash: z.boolean().optional(),
    remove_source_branch: z.boolean().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {};
    if (args.merge_commit_message !== undefined) body.merge_commit_message = args.merge_commit_message;
    if (args.squash !== undefined) body.squash = args.squash;
    if (args.remove_source_branch !== undefined) body.should_remove_source_branch = args.remove_source_branch;
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}/merge`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const m = await res.json();
    if (!m || typeof m !== "object") return m;
    return { iid: m.iid, state: m.state, merge_commit_sha: m.merge_commit_sha };
  },
};

export const closeMR = {
  name: "gitlab_close_mr",
  description:
    "Close (reject) a merge request without merging. The author must reopen it to resurrect it. Prefer leaving review feedback via gitlab_add_mr_comment if you only want revisions. Returns { iid, state }.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    mrIid: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/merge_requests/${args.mrIid}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state_event: "close" }),
    });
    const m = await res.json();
    if (!m || typeof m !== "object") return m;
    return { iid: m.iid, state: m.state };
  },
};

// ---------------------------------------------------------------------------
// CI (pipelines)
// ---------------------------------------------------------------------------

export const listPipelines = {
  name: "gitlab_list_pipelines",
  description:
    "List CI pipelines for a GitLab project as slim rows { id, status, ref, sha (12 chars), source, updated_at, web_url }, newest first. Optional `ref` and `status` (e.g. success, failed, running) filters. Defaults: 20 per page.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    ref: z.string().optional(),
    status: z.string().optional().describe("e.g. success | failed | running | pending | canceled"),
    perPage: z.number().default(20),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.ref) params.set("ref", args.ref);
    if (args.status) params.set("status", args.status);
    params.set("per_page", String(args.perPage ?? 20));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/pipelines?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((p: any) => ({
      id: p.id,
      status: p.status,
      ref: p.ref,
      sha: typeof p.sha === "string" ? p.sha.slice(0, 12) : p.sha,
      source: p.source,
      updated_at: p.updated_at,
      web_url: p.web_url,
    }));
  },
};

function slimPipeline(p: any) {
  return {
    id: p.id,
    status: p.status,
    ref: p.ref,
    sha: typeof p.sha === "string" ? p.sha.slice(0, 12) : p.sha,
    source: p.source,
    web_url: p.web_url,
    created_at: p.created_at,
    updated_at: p.updated_at,
  };
}

export const triggerPipeline = {
  name: "gitlab_trigger_pipeline",
  description:
    "Trigger a new CI pipeline for a GitLab project on a branch or tag (`ref`). Optional `variables` are passed as CI/CD variables for the run. Returns a slim pipeline { id, status, ref, sha, source, web_url, created_at, updated_at } — poll gitlab_get_pipeline with the id for status. The project must have a .gitlab-ci.yml on that ref or GitLab returns 400.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    ref: z.string().describe("Branch or tag to run the pipeline on"),
    variables: z.record(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { ref: args.ref };
    if (args.variables) {
      body.variables = Object.entries(args.variables).map(([key, value]) => ({ key, value }));
    }
    const res = await ctx.http(`${apiBase(ctx)}/projects/${pid(args.project)}/pipeline`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const p = await res.json();
    if (!p || typeof p.id !== "number") return p;
    return slimPipeline(p);
  },
};

export const getPipeline = {
  name: "gitlab_get_pipeline",
  description:
    "Get a single GitLab CI pipeline by id as a slim object { id, status, ref, sha, source, web_url, created_at, updated_at }. Use to poll a pipeline you triggered (status: created | pending | running | success | failed | canceled).",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string(),
    pipelineId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/pipelines/${args.pipelineId}`
    );
    const p = await res.json();
    if (!p || typeof p.id !== "number") return p;
    return slimPipeline(p);
  },
};

export const retryPipeline = {
  name: "gitlab_retry_pipeline",
  description:
    "Retry the failed and canceled jobs in a GitLab pipeline by id. Returns the slim pipeline; on failure returns GitLab's error body.",
  integration: INTEGRATION,
  effect: "write",
  inputSchema: z.object({
    project: z.string(),
    pipelineId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/pipelines/${args.pipelineId}/retry`,
      { method: "POST" }
    );
    const p = await res.json();
    if (!p || typeof p.id !== "number") return p;
    return slimPipeline(p);
  },
};

export const cancelPipeline = {
  name: "gitlab_cancel_pipeline",
  description:
    "Cancel a running GitLab pipeline by id (cancels its running/pending jobs). Returns the slim pipeline; on failure returns GitLab's error body.",
  integration: INTEGRATION,
  effect: "destructive",
  inputSchema: z.object({
    project: z.string(),
    pipelineId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${apiBase(ctx)}/projects/${pid(args.project)}/pipelines/${args.pipelineId}/cancel`,
      { method: "POST" }
    );
    const p = await res.json();
    if (!p || typeof p.id !== "number") return p;
    return slimPipeline(p);
  },
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export const searchProjects = {
  name: "gitlab_search_projects",
  description:
    "Search projects across the GitLab instance by name/path as slim rows { id, path_with_namespace, visibility, default_branch, description }. Default 10 results. Use the id or path_with_namespace as `project` in other tools.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    q: z.string(),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("scope", "projects");
    params.set("search", args.q);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const res = await ctx.http(`${apiBase(ctx)}/search?${params}`);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((p: any) => ({
      id: p.id,
      path_with_namespace: p.path_with_namespace,
      visibility: p.visibility,
      default_branch: p.default_branch,
      description: truncate(p.description, 200),
    }));
  },
};

export const searchCode = {
  name: "gitlab_search_code",
  description:
    "Search code (blobs) across the GitLab instance as slim rows { path, project_id, ref, startline, data }. Scope to a project with `project` (faster and works on all tiers — global blob search needs Advanced Search/Elasticsearch on self-hosted). Default 10 results. Follow up with gitlab_get_file to read a match.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    q: z.string(),
    project: z.string().optional().describe("Limit to one project (id or path); recommended"),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("scope", "blobs");
    params.set("search", args.q);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const url = args.project
      ? `${apiBase(ctx)}/projects/${pid(args.project)}/search?${params}`
      : `${apiBase(ctx)}/search?${params}`;
    const res = await ctx.http(url);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((b: any) => ({
      path: b.path,
      project_id: b.project_id,
      ref: b.ref,
      startline: b.startline,
      data: truncate(b.data, 300),
    }));
  },
};

export const searchIssues = {
  name: "gitlab_search_issues",
  description:
    "Search issues across the GitLab instance (or one project if `project` is set) as slim rows { iid, project_id, title, state, author, labels, updated_at }. Default 10 results. For one known project, gitlab_list_issues is cheaper.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    q: z.string(),
    project: z.string().optional(),
    perPage: z.number().default(10),
    page: z.number().default(1),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("scope", "issues");
    params.set("search", args.q);
    params.set("per_page", String(args.perPage ?? 10));
    params.set("page", String(args.page ?? 1));
    const url = args.project
      ? `${apiBase(ctx)}/projects/${pid(args.project)}/search?${params}`
      : `${apiBase(ctx)}/search?${params}`;
    const res = await ctx.http(url);
    const data = await res.json();
    if (!Array.isArray(data)) return data;
    return data.map((i: any) => ({
      iid: i.iid,
      project_id: i.project_id,
      title: i.title,
      state: i.state,
      author: i.author?.username,
      labels: i.labels ?? [],
      updated_at: i.updated_at,
    }));
  },
};

// ---------------------------------------------------------------------------
// Clone URL
// ---------------------------------------------------------------------------

export const getCloneUrl = {
  name: "gitlab_get_clone_url",
  description:
    "Mint a temporary authenticated HTTPS git URL for a project (https://oauth2:<token>@host/path.git), usable for clone/pull/push (the `api` scope covers push). The embedded OAuth token is short-lived and the URL dies with it — re-call this right before a push rather than storing the URL. Do NOT persist it in .git/config or scripts: anyone holding the URL holds the token until expiry. `project` must be the path_with_namespace (e.g. 'group/repo'), not the numeric id.",
  integration: INTEGRATION,
  effect: "read",
  inputSchema: z.object({
    project: z.string().describe("path_with_namespace, e.g. 'group/repo'"),
  }),
  handler: async (ctx: any, args: any) => {
    const token = await ctx.getToken();
    const host = origin(ctx).replace(/^https?:\/\//, "");
    const path = String(args.project).replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
    return {
      cloneUrl: `https://oauth2:${token}@${host}/${path}.git`,
      note: "Token-bearing URL — expires with the OAuth access token. Re-mint before pushing; don't store it.",
    };
  },
};
