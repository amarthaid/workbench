import { z } from "zod";

const BASE = "https://api.bitbucket.org/2.0";

/**
 * Resolve the workspace slug. When the caller omits `workspace`, fall back to
 * the first workspace the authenticated user belongs to (one extra GET).
 */
async function resolveWorkspace(ctx: any, workspace?: string): Promise<string> {
  if (workspace) return workspace;
  const res = await ctx.http(`${BASE}/workspaces?pagelen=1`);
  const data = await res.json();
  const slug = data?.values?.[0]?.slug;
  if (!slug) {
    throw new Error("No Bitbucket workspace found for this account; pass `workspace` explicitly.");
  }
  return slug;
}

/** Read a text-bodied response; falls back to json() for ctx.http impls without text(). */
async function readText(res: any): Promise<string> {
  const text = res.text ? await res.text() : await res.json();
  return typeof text === "string" ? text : JSON.stringify(text);
}

// Bitbucket's REST payloads are ~95% links/avatars/nested owner objects
// (live-measured ~30 KB for 10 repos). Shape every response down to the
// fields an agent actually acts on. See
// docs/findings/2026-06-12-builtin-tools-round-review.md.

function slimRepo(r: any) {
  return {
    slug: r.slug,
    name: r.name,
    full_name: r.full_name,
    is_private: r.is_private,
    mainbranch: r.mainbranch?.name,
    updated_on: r.updated_on,
    description: typeof r.description === "string" ? r.description.slice(0, 200) : undefined,
  };
}

function slimPRRow(pr: any) {
  return {
    id: pr.id,
    title: pr.title,
    state: pr.state,
    author: pr.author?.display_name,
    source: pr.source?.branch?.name,
    destination: pr.destination?.branch?.name,
    updated_on: pr.updated_on,
  };
}

function slimPRDetail(pr: any) {
  return {
    id: pr.id,
    title: pr.title,
    description: pr.description,
    state: pr.state,
    author: pr.author?.display_name,
    source: pr.source?.branch?.name,
    destination: pr.destination?.branch?.name,
    reviewers: (pr.participants ?? []).map((p: any) => ({
      display_name: p.user?.display_name,
      uuid: p.user?.uuid,
      approved: p.approved,
    })),
    comment_count: pr.comment_count,
    task_count: pr.task_count,
    created_on: pr.created_on,
    updated_on: pr.updated_on,
    url: pr.links?.html?.href,
  };
}

export const listRepos = {
  name: "bitbucket_list_repos",
  description:
    "List repositories in a Bitbucket workspace as slim rows (slug, name, full_name, is_private, main branch, updated_on, description) — no links/avatars/clone noise. `workspace` is optional and defaults to the user's first workspace; pass it explicitly if the account belongs to several. Returns { repos, hasMore }; page forward with `page` (pagelen defaults to 10). Use bitbucket_get_repo for clone URL and full detail on one repo.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string().optional().describe("Workspace slug; defaults to the user's first workspace"),
    page: z.number().default(1),
    pagelen: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const params = new URLSearchParams();
    params.set("page", String(args.page ?? 1));
    params.set("pagelen", String(args.pagelen ?? 10));
    const res = await ctx.http(`${BASE}/repositories/${workspace}?${params}`);
    const data = await res.json();
    return {
      workspace,
      repos: (data.values ?? []).map(slimRepo),
      hasMore: Boolean(data.next),
    };
  },
};

export const getRepo = {
  name: "bitbucket_get_repo",
  description:
    "Get one Bitbucket repository: slug, name, full_name, privacy, main branch, last update, description, and the https clone URL. Use after bitbucket_list_repos when you need the clone URL or to confirm the main branch before creating a PR.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/repositories/${args.workspace}/${args.repoSlug}`);
    const data = await res.json();
    return {
      ...slimRepo(data),
      clone_https: (data.links?.clone ?? []).find((c: any) => c.name === "https")?.href,
    };
  },
};

export const createPR = {
  name: "bitbucket_create_pr",
  description:
    "Create a Bitbucket pull request from sourceBranch into destinationBranch (default \"main\" — check the repo's actual main branch with bitbucket_get_repo first if unsure). UPSERT BEHAVIOR: If an open PR already exists from the same sourceBranch, this tool updates that PR instead of creating a duplicate — use this to add reviewers to an existing PR. Optionally pass `reviewers` (array of user UUIDs) to add reviewers at creation time — get UUIDs from bitbucket_search_users (search by name) or bitbucket_list_default_reviewers (repo's configured defaults). NOTE: The PR author cannot be added as a reviewer — Bitbucket rejects the entire request silently if the author's UUID is included. The tool automatically filters out the PR author from the reviewers list. Returns the new PR's id, state, branches, reviewers, and html URL. Follow up with bitbucket_get_pr / bitbucket_get_pr_diff to review it.",
  integration: "atlassian-bitbucket",
  effect: "write",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    title: z.string(),
    sourceBranch: z.string(),
    destinationBranch: z.string().default("main"),
    description: z.string().optional(),
    reviewers: z
      .array(z.string())
      .optional()
      .describe("User UUIDs to add as reviewers (get from bitbucket_search_users or bitbucket_list_default_reviewers)"),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {
      title: args.title,
      source: { branch: { name: args.sourceBranch } },
      destination: { branch: { name: args.destinationBranch ?? "main" } },
      description: args.description,
    };
    if (args.reviewers?.length) {
      // Get current user to identify PR author — Bitbucket silently rejects
      // adding the author as a reviewer, which fails the entire request.
      const userRes = await ctx.http(`${BASE}/user`);
      const currentUser = await userRes.json();
      const authorUuid = currentUser.uuid?.replace(/[{}]/g, "");

      const filteredReviewers = args.reviewers
        .filter((uuid: string) => {
          const normalized = uuid.replace(/[{}]/g, "");
          return normalized !== authorUuid;
        })
        .map((uuid: string) => ({ uuid }));

      if (filteredReviewers.length < args.reviewers.length) {
        console.warn(
          `[bitbucket_create_pr] Excluded PR author from reviewers (Bitbucket rejects author-as-reviewer)`
        );
      }

      if (filteredReviewers.length > 0) {
        body.reviewers = filteredReviewers;
      }
    }
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    return slimPRDetail(data);
  },
};

export const listPRs = {
  name: "bitbucket_list_prs",
  description:
    "List pull requests in a repository as slim rows (id, title, state, author, source/destination branch, updated_on). `state` defaults to OPEN; pass MERGED/DECLINED/SUPERSEDED for history. Returns { prs, hasMore }; page forward with `page`. Use bitbucket_get_pr for reviewers, counts, and the PR URL.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    state: z.enum(["OPEN", "MERGED", "DECLINED", "SUPERSEDED"]).default("OPEN"),
    page: z.number().default(1),
    pagelen: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("state", args.state ?? "OPEN");
    params.set("page", String(args.page ?? 1));
    params.set("pagelen", String(args.pagelen ?? 10));
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests?${params}`
    );
    const data = await res.json();
    return {
      prs: (data.values ?? []).map(slimPRRow),
      hasMore: Boolean(data.next),
    };
  },
};

export const getPR = {
  name: "bitbucket_get_pr",
  description:
    "Get one pull request: title, description, state, author, source/destination branches, reviewers with approval status, comment/task counts, timestamps, and html URL. Always check this (state, approvals, open tasks) before bitbucket_merge_pr. For the code changes use bitbucket_get_pr_diff.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    pullRequestId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.pullRequestId}`
    );
    const data = await res.json();
    return slimPRDetail(data);
  },
};

export const getPRDiff = {
  name: "bitbucket_get_pr_diff",
  description:
    "Get the changes in a pull request. With diffstat=true (recommended first for big PRs) returns one slim row per file: { status, old, new, lines_added, lines_removed } — far cheaper than the full diff. With diffstat=false (default) returns the raw unified diff text of the whole PR, which can be very large. Typical flow: diffstat first, then full diff only if you need to read the actual code.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
    diffstat: z
      .boolean()
      .default(false)
      .describe("true = per-file summary rows (cheap); false = full unified diff text"),
  }),
  handler: async (ctx: any, args: any) => {
    const base = `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}`;
    if (args.diffstat) {
      const res = await ctx.http(`${base}/diffstat`);
      const data = await res.json();
      return {
        files: (data.values ?? []).map((f: any) => ({
          status: f.status,
          old: f.old?.path,
          new: f.new?.path,
          lines_added: f.lines_added,
          lines_removed: f.lines_removed,
        })),
        hasMore: Boolean(data.next),
      };
    }
    const res = await ctx.http(`${base}/diff`);
    return readText(res);
  },
};

export const listPRComments = {
  name: "bitbucket_list_pr_comments",
  description:
    "List comments on a pull request as slim rows: { id, author, text, inline: { path, line } for code comments (absent for general comments), created_on }. pagelen defaults to 20. Returns { comments, hasMore }. Use before replying with bitbucket_add_pr_comment to see existing review feedback.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
    pagelen: z.number().default(20),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("pagelen", String(args.pagelen ?? 20));
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/comments?${params}`
    );
    const data = await res.json();
    return {
      comments: (data.values ?? []).map((c: any) => ({
        id: c.id,
        author: c.user?.display_name,
        text: c.content?.raw,
        inline: c.inline ? { path: c.inline.path, line: c.inline.to ?? c.inline.from } : undefined,
        created_on: c.created_on,
      })),
      hasMore: Boolean(data.next),
    };
  },
};

export const addPRComment = {
  name: "bitbucket_add_pr_comment",
  description:
    "Add a comment to a pull request. Plain `text` posts a general comment; also pass `inline` { path, line } to attach it to a specific line of a changed file (get paths/lines from bitbucket_get_pr_diff). Returns { id, created_on }.",
  integration: "atlassian-bitbucket",
  effect: "write",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
    text: z.string(),
    inline: z
      .object({
        path: z.string().describe("File path within the PR diff"),
        line: z.number().describe("Line number in the new version of the file"),
      })
      .optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = { content: { raw: args.text } };
    if (args.inline) body.inline = { path: args.inline.path, to: args.inline.line };
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/comments`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    return { id: data.id, created_on: data.created_on };
  },
};

export const approvePR = {
  name: "bitbucket_approve_pr",
  description:
    "Approve a pull request as the connected user (the green checkmark reviewers see). Non-destructive and revocable in the Bitbucket UI. Review the changes with bitbucket_get_pr_diff before approving. Returns { approved: true }.",
  integration: "atlassian-bitbucket",
  effect: "destructive",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/approve`,
      { method: "POST" }
    );
    await res.json();
    return { approved: true };
  },
};

export const requestChanges = {
  name: "bitbucket_request_changes",
  description:
    "Mark a pull request as \"changes requested\" by the connected user — signals the author to revise before merge. Pair with bitbucket_add_pr_comment to explain what needs changing. Returns { requested: true }.",
  integration: "atlassian-bitbucket",
  effect: "write",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/request-changes`,
      { method: "POST" }
    );
    await res.json();
    return { requested: true };
  },
};

export const mergePR = {
  name: "bitbucket_merge_pr",
  description:
    "Merge a pull request into its destination branch. IRREVERSIBLE: this lands the commits on the destination branch — check state, approvals, and open tasks with bitbucket_get_pr first, and only merge when explicitly asked to. Optional: `message` (merge commit message), `merge_strategy` (merge_commit | squash | fast_forward), `close_source_branch`. Returns the merged PR's id and state.",
  integration: "atlassian-bitbucket",
  effect: "destructive",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
    message: z.string().optional(),
    merge_strategy: z.enum(["merge_commit", "squash", "fast_forward"]).optional(),
    close_source_branch: z.boolean().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {};
    if (args.message !== undefined) body.message = args.message;
    if (args.merge_strategy !== undefined) body.merge_strategy = args.merge_strategy;
    if (args.close_source_branch !== undefined) body.close_source_branch = args.close_source_branch;
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/merge`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const data = await res.json();
    return { id: data.id, state: data.state, merge_commit: data.merge_commit?.hash };
  },
};

export const declinePR = {
  name: "bitbucket_decline_pr",
  description:
    "Decline (reject) a pull request. WARNING: this closes the PR without merging — the author must open a new PR to resurrect it. Prefer bitbucket_request_changes if you only want revisions. Returns the PR's id and state.",
  integration: "atlassian-bitbucket",
  effect: "destructive",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/decline`,
      { method: "POST" }
    );
    const data = await res.json();
    return { id: data.id, state: data.state };
  },
};

export const getFile = {
  name: "bitbucket_get_file",
  description:
    "Read a file's raw text content from a repository at a specific ref. `ref` is required and must be a real branch name or commit hash (e.g. \"main\" or a 40-char SHA — \"HEAD\" is NOT valid on this API). Useful for seeing surrounding code that a PR diff doesn't show. Returns the file contents as plain text.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    ref: z.string().describe("Branch name or commit hash (\"HEAD\" is not valid)"),
    path: z.string().describe("File path within the repository"),
  }),
  handler: async (ctx: any, args: any) => {
    const encodedPath = String(args.path)
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/src/${encodeURIComponent(args.ref)}/${encodedPath}`
    );
    return readText(res);
  },
};

export const listPRCommits = {
  name: "bitbucket_list_pr_commits",
  description:
    "List the commits in a pull request as slim rows: { hash (12 chars), message (first line only), author, date }. Cheaper than the diff for understanding the shape/history of a PR. Returns { commits, hasMore }.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string(),
    repoSlug: z.string(),
    prId: z.number(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(
      `${BASE}/repositories/${args.workspace}/${args.repoSlug}/pullrequests/${args.prId}/commits`
    );
    const data = await res.json();
    return {
      commits: (data.values ?? []).map((c: any) => ({
        hash: c.hash?.slice(0, 12),
        message: typeof c.message === "string" ? c.message.split("\n")[0] : undefined,
        author: c.author?.user?.display_name ?? c.author?.raw,
        date: c.date,
      })),
      hasMore: Boolean(data.next),
    };
  },
};

// Bitbucket pipeline payloads nest state under state.name / state.result.name /
// state.stage.name and carry link/avatar blobs. Shape to the fields an agent acts on.
function slimPipeline(p: any) {
  return {
    uuid: p.uuid,
    build_number: p.build_number,
    state: p.state?.name,
    result: p.state?.result?.name ?? p.state?.stage?.name,
    ref_name: p.target?.ref_name,
    created_on: p.created_on,
    completed_on: p.completed_on,
  };
}

export const triggerPipeline = {
  name: "bitbucket_trigger_pipeline",
  description:
    "Trigger a Bitbucket Pipelines run on a branch (`ref`). Optional `custom` runs a custom pipeline defined under `pipelines.custom.<name>` in bitbucket-pipelines.yml; omit it to run the branch's default pipeline. Optional `variables` ({KEY: value}) are passed to the run — custom pipelines that declare `variables:` read them here; pass `secured` (list of variable names) to mark those secured/masked. Returns a slim pipeline { uuid, build_number, state, result, ref_name, created_on, completed_on } — poll bitbucket_get_pipeline with the uuid. Requires the pipeline scope and Pipelines enabled on the repo. workspace defaults to the user's first workspace.",
  integration: "atlassian-bitbucket",
  effect: "destructive",
  inputSchema: z.object({
    workspace: z.string().optional(),
    repoSlug: z.string(),
    ref: z.string().describe("Branch name to run the pipeline on"),
    custom: z.string().optional().describe("Name of a custom pipeline definition to run"),
    variables: z.record(z.string()).optional().describe("Pipeline variables as { KEY: value }"),
    secured: z.array(z.string()).optional().describe("Names of variables to mark as secured/masked"),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const body: any = {
      target: {
        ref_type: "branch",
        type: "pipeline_ref_target",
        ref_name: args.ref,
      },
    };
    if (args.custom) {
      body.target.selector = { type: "custom", pattern: args.custom };
    }
    // Pipeline variables live on the request body (not under target). Bitbucket
    // wants [{key, value, secured}]; map the caller's {KEY: value} object.
    if (args.variables) {
      const secured = new Set(args.secured ?? []);
      body.variables = Object.entries(args.variables).map(([key, value]) => ({
        key,
        value,
        secured: secured.has(key),
      }));
    }
    const res = await ctx.http(
      `${BASE}/repositories/${workspace}/${args.repoSlug}/pipelines/`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    );
    const p = await res.json();
    if (!p || !p.uuid) return p;
    return slimPipeline(p);
  },
};

export const getPipeline = {
  name: "bitbucket_get_pipeline",
  description:
    "Get a single Bitbucket pipeline by uuid (or build number) as a slim object { uuid, build_number, state, result, ref_name, created_on, completed_on }. Use to poll a pipeline you triggered (state: PENDING | IN_PROGRESS | COMPLETED; result: SUCCESSFUL | FAILED | STOPPED). workspace defaults to the user's first workspace.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string().optional(),
    repoSlug: z.string(),
    pipelineUuid: z.string().describe("Pipeline uuid (with braces) or build number"),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const res = await ctx.http(
      `${BASE}/repositories/${workspace}/${args.repoSlug}/pipelines/${encodeURIComponent(args.pipelineUuid)}`
    );
    const p = await res.json();
    if (!p || !p.uuid) return p;
    return slimPipeline(p);
  },
};

export const stopPipeline = {
  name: "bitbucket_stop_pipeline",
  description:
    "Stop a running Bitbucket pipeline by uuid. Returns { ok: true } on success (204 No Content); on failure returns Bitbucket's { ok:false, status, error } body. workspace defaults to the user's first workspace.",
  integration: "atlassian-bitbucket",
  effect: "destructive",
  inputSchema: z.object({
    workspace: z.string().optional(),
    repoSlug: z.string(),
    pipelineUuid: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const res = await ctx.http(
      `${BASE}/repositories/${workspace}/${args.repoSlug}/pipelines/${encodeURIComponent(args.pipelineUuid)}/stopPipeline`,
      { method: "POST" }
    );
    if (res.status === 204) return { ok: true };
    return { ok: false, status: res.status, error: await res.json().catch(() => res.statusText) };
  },
};

export const getCloneUrl = {
  name: "bitbucket_get_clone_url",
  description:
    "Mint a temporary authenticated HTTPS git URL for a repo (https://x-token-auth:<token>@bitbucket.org/ws/slug.git), usable for clone/pull/push. The embedded OAuth token expires (typically ≤2h) and the URL dies with it — re-call this right before a push rather than storing the URL. Do NOT persist it in .git/config or scripts: anyone holding the URL holds the token until expiry. Push requires the repository:write scope on the connection (reconnect if it was added after connecting). workspace defaults to the user's first workspace.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string().optional(),
    repoSlug: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const token = await ctx.getToken();
    return {
      cloneUrl: `https://x-token-auth:${token}@bitbucket.org/${workspace}/${args.repoSlug}.git`,
      note: "Token-bearing URL — expires with the OAuth access token (≤2h). Re-mint before pushing; don't store it.",
    };
  },
};

export const listDefaultReviewers = {
  name: "bitbucket_list_default_reviewers",
  description:
    'List the default reviewers that will auto-attach to new pull requests on a repository. Returns slim rows { display_name, uuid, reviewer_type: "project"|"repository" } — project ones are inherited from the workspace project, repository ones were set on this repo (requires repository:admin to add). Bitbucket auto-adds these to every new PR even without passing them to bitbucket_create_pr — use this to see who will review by default, or pass a returned uuid into bitbucket_create_pr reviewers explicitly. workspace defaults to the first workspace.',
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string().optional(),
    repoSlug: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const res = await ctx.http(
      `${BASE}/repositories/${workspace}/${args.repoSlug}/effective-default-reviewers?pagelen=100`
    );
    const data = await res.json();
    return {
      reviewers: (data.values ?? []).map((r: any) => ({
        display_name: r.user?.display_name,
        uuid: r.user?.uuid,
        reviewer_type: r.reviewer_type,
      })),
    };
  },
};

export const searchUsers = {
  name: "bitbucket_search_users",
  description:
    "Search Bitbucket workspace members by name or username to resolve user UUIDs for use with bitbucket_create_pr reviewers. Substring match against display_name OR nickname (case-insensitive) — 'alex' matches 'Jane Alexander' and 'alexp'. Only finds workspace members, not external repo-only collaborators. Email filtering not supported (Bitbucket gates that behind admin scope). Returns { users: [{ display_name, nickname, uuid }], hasMore } — page forward with page. workspace defaults to the first workspace.",
  integration: "atlassian-bitbucket",
  effect: "read",
  inputSchema: z.object({
    workspace: z.string().optional(),
    query: z
      .string()
      .describe("Case-insensitive substring matched against display_name and nickname"),
    page: z.number().default(1),
    pagelen: z.number().default(50),
  }),
  handler: async (ctx: any, args: any) => {
    const workspace = await resolveWorkspace(ctx, args.workspace);
    const params = new URLSearchParams();
    params.set("page", String(args.page ?? 1));
    params.set("pagelen", String(args.pagelen ?? 50));
    const res = await ctx.http(`${BASE}/workspaces/${workspace}/members?${params}`);
    const data = await res.json();
    const q = String(args.query).toLowerCase();
    return {
      users: (data.values ?? [])
        .filter(
          (m: any) =>
            (m.user?.display_name ?? "").toLowerCase().includes(q) ||
            (m.user?.nickname ?? "").toLowerCase().includes(q)
        )
        .map((m: any) => ({
          display_name: m.user?.display_name,
          nickname: m.user?.nickname,
          uuid: m.user?.uuid,
        })),
      hasMore: Boolean(data.next),
    };
  },
};
