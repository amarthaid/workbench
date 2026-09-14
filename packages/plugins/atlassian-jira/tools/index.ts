import { z } from "zod";

const BASE = "https://api.atlassian.com/ex/jira/cloud-id/rest/api/3";
const AGILE_BASE = "https://api.atlassian.com/ex/jira/cloud-id/rest/agile/1.0";

/** Wrap plain text in a minimal Atlassian Document Format doc (one paragraph). */
function textToAdf(text: string) {
  return {
    type: "doc",
    version: 1,
    content: [
      {
        type: "paragraph",
        content: [{ type: "text", text }],
      },
    ],
  };
}

/**
 * Extract plain text from an Atlassian Document Format node. Simple recursive
 * walk: text nodes contribute their text, hardBreaks become newlines, and
 * block containers (doc, lists, blockquote) join children with newlines.
 */
function adfToText(node: any): string {
  if (node == null || typeof node !== "object") return "";
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hardBreak") return "\n";
  const children = Array.isArray(node.content) ? node.content.map(adfToText) : [];
  const joinWithNewline = new Set(["doc", "bulletList", "orderedList", "blockquote", "listItem"]);
  return children.join(joinWithNewline.has(node.type) ? "\n" : "");
}

const SEARCH_DEFAULT_FIELDS = ["summary", "status", "assignee", "priority", "updated"];

/** Map one raw issue (with .fields) to a slim row for the requested field list. */
function shapeIssueRow(issue: any, requestedFields: string[]) {
  const f = issue.fields ?? {};
  const row: any = { key: issue.key, id: issue.id };
  const extras: Record<string, unknown> = {};
  for (const field of requestedFields) {
    switch (field) {
      case "summary":
        row.summary = f.summary;
        break;
      case "status":
        row.status = f.status?.name;
        break;
      case "assignee":
        row.assignee = f.assignee?.displayName;
        break;
      case "priority":
        row.priority = f.priority?.name;
        break;
      case "updated":
        row.updated = f.updated;
        break;
      default:
        extras[field] = f[field];
    }
  }
  if (Object.keys(extras).length) row.fields = extras;
  return row;
}

export const createIssue = {
  name: "jira_create_issue",
  description:
    "Create a Jira issue and return its { id, key, self }. description is plain text (wrapped in ADF automatically); issueType defaults to \"Task\". Find a valid projectKey with jira_list_projects first. Pass fields to include additional or required custom fields (e.g. { \"customfield_10016\": { \"id\": \"123\" } }) — keys in fields are merged in, with named args taking precedence on conflict.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    projectKey: z.string(),
    summary: z.string(),
    description: z.string().optional(),
    issueType: z.string().default("Task"),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const fields: Record<string, unknown> = {
      ...(args.fields ?? {}),
      project: { key: args.projectKey },
      summary: args.summary,
      issuetype: { name: args.issueType },
    };
    if (args.description !== undefined) fields.description = textToAdf(args.description);
    const res = await ctx.http(`${BASE}/issue`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    return res.json();
  },
};

export const searchIssues = {
  name: "jira_search_issues",
  description:
    "Search Jira issues with a JQL query; returns slim rows { key, id, summary, status, assignee, priority, updated } plus nextPageToken for paging (maxResults defaults to 10). Pass fields to request other fields (returned raw under each row's fields). Use jira_get_issue for one issue's full detail including description.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    jql: z.string(),
    maxResults: z.number().default(10),
    nextPageToken: z.string().optional(),
    fields: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    // CHANGE-2046: legacy /rest/api/3/search was removed; use /search/jql.
    // /search/jql returns bare IDs unless fields are requested, so always
    // send a fields param (defaulting to a useful slim set).
    const requestedFields: string[] = args.fields?.length ? args.fields : SEARCH_DEFAULT_FIELDS;
    const params = new URLSearchParams();
    params.set("jql", args.jql);
    params.set("maxResults", String(args.maxResults));
    if (args.nextPageToken) params.set("nextPageToken", args.nextPageToken);
    params.set("fields", requestedFields.join(","));
    const res = await ctx.http(`${BASE}/search/jql?${params}`);
    const data = await res.json();
    return {
      issues: (data.issues ?? []).map((issue: any) => shapeIssueRow(issue, requestedFields)),
      nextPageToken: data.nextPageToken,
    };
  },
};

export const getIssue = {
  name: "jira_get_issue",
  description:
    "Get one Jira issue by key as { key, id, summary, status, assignee, reporter, priority, issueType, created, updated, description (plain text extracted from ADF), labels, parent, url }. Pass fields to additionally get specific raw fields (e.g. customfield_*) under fields. Use jira_search_issues to find issues by JQL first.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
    fields: z.array(z.string()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}`);
    const data = await res.json();
    const f = data.fields ?? {};
    const out: any = {
      key: data.key,
      id: data.id,
      summary: f.summary,
      status: f.status?.name,
      assignee: f.assignee?.displayName,
      reporter: f.reporter?.displayName,
      priority: f.priority?.name,
      issueType: f.issuetype?.name,
      created: f.created,
      updated: f.updated,
      description: f.description ? adfToText(f.description) : undefined,
      labels: f.labels,
      parent: f.parent?.key,
      url: data.self,
    };
    if (args.fields?.length) {
      out.fields = Object.fromEntries(args.fields.map((name: string) => [name, f[name]]));
    }
    return out;
  },
};

export const searchUsers = {
  name: "jira_search_users",
  description:
    "Search Jira users by name or email; returns slim rows { accountId, displayName, emailAddress, active } (maxResults defaults to 10). Use the accountId with jira_update_issue's assigneeAccountId to assign issues.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    query: z.string(),
    maxResults: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("query", args.query);
    params.set("maxResults", String(args.maxResults));
    const res = await ctx.http(`${BASE}/user/search?${params}`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((u: any) => ({
      accountId: u.accountId,
      displayName: u.displayName,
      emailAddress: u.emailAddress,
      active: u.active,
    }));
  },
};

export const getBoards = {
  name: "jira_get_boards",
  description:
    "List Jira agile boards as { boards: [{ id, name, type, projectKey }], total, isLast }; optionally filter by projectKey (maxResults defaults to 50). Requires the read:board-scope:jira-software scope — reconnect Jira if this returns 401.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    projectKey: z.string().optional(),
    maxResults: z.number().default(50),
    startAt: z.number().default(0),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.projectKey) params.set("projectKeyOrId", args.projectKey);
    params.set("maxResults", String(args.maxResults));
    params.set("startAt", String(args.startAt));
    const res = await ctx.http(`${AGILE_BASE}/board?${params}`);
    const data = await res.json();
    return {
      boards: (data.values ?? []).map((b: any) => ({
        id: b.id,
        name: b.name,
        type: b.type,
        projectKey: b.location?.projectKey,
      })),
      total: data.total,
      isLast: data.isLast,
    };
  },
};

export const getProjectTypes = {
  name: "jira_project_types",
  description:
    "List the Jira project types available on this site as slim rows { key, formattedKey, type } (icons stripped). Rarely needed — use jira_list_projects to discover actual projects and their keys.",
  integration: "atlassian-jira",
  inputSchema: z.object({}),
  handler: async (ctx: any, _args: any) => {
    const res = await ctx.http(`${BASE}/project/type`);
    const data = await res.json();
    return (Array.isArray(data) ? data : []).map((t: any) => ({
      key: t.key,
      formattedKey: t.formattedKey,
      type: t.type,
    }));
  },
};

export const updateIssue = {
  name: "jira_update_issue",
  description:
    "Update a Jira issue's summary, description (plain text, wrapped in ADF), assignee (assigneeAccountId from jira_search_users), and/or labels — only the args you pass are changed; returns { success: true }. To change status use jira_transition_issue instead (status is not a field). Pass fields to set additional custom fields (e.g. { \"customfield_10016\": { \"id\": \"123\" } }) — named args take precedence on conflict.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
    summary: z.string().optional(),
    description: z.string().optional(),
    assigneeAccountId: z.string().optional(),
    labels: z.array(z.string()).optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const fields: Record<string, unknown> = { ...(args.fields ?? {}) };
    if (args.summary !== undefined) fields.summary = args.summary;
    if (args.description !== undefined) fields.description = textToAdf(args.description);
    if (args.assigneeAccountId !== undefined) fields.assignee = { accountId: args.assigneeAccountId };
    if (args.labels !== undefined) fields.labels = args.labels;
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    });
    if (res.status === 204) return { success: true };
    return res.json();
  },
};

export const getTransitions = {
  name: "jira_get_transitions",
  description:
    "List the status transitions currently available for an issue as [{ id, name, toStatus }] — transitions depend on the issue's current status and workflow. Call this first to get the id required by jira_transition_issue.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}/transitions`);
    const data = await res.json();
    return (data.transitions ?? []).map((t: any) => ({
      id: t.id,
      name: t.name,
      toStatus: t.to?.name,
    }));
  },
};

export const transitionIssue = {
  name: "jira_transition_issue",
  description:
    "Move a Jira issue to another status by applying a workflow transition; returns { success: true }. transitionId must come from jira_get_transitions for the same issue (ids vary per workflow and current status).",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
    transitionId: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}/transitions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transition: { id: args.transitionId } }),
    });
    if (res.status === 204) return { success: true };
    return res.json();
  },
};

export const addComment = {
  name: "jira_add_comment",
  description:
    "Add a comment to a Jira issue; body is plain text (wrapped in ADF automatically). Returns { id, created } of the new comment — use jira_get_comments to read the thread.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
    body: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}/comment`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: textToAdf(args.body) }),
    });
    const data = await res.json();
    return { id: data.id, created: data.created };
  },
};

export const getComments = {
  name: "jira_get_comments",
  description:
    "Read the comments on a Jira issue as slim rows { id, author, body (plain text extracted from ADF), created }, oldest first (maxResults defaults to 10). Use jira_add_comment to reply.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    issueKey: z.string(),
    maxResults: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(args.maxResults));
    const res = await ctx.http(`${BASE}/issue/${args.issueKey}/comment?${params}`);
    const data = await res.json();
    return (data.comments ?? []).map((c: any) => ({
      id: c.id,
      author: c.author?.displayName,
      body: c.body ? adfToText(c.body) : undefined,
      created: c.created,
    }));
  },
};

export const listProjects = {
  name: "jira_list_projects",
  description:
    "List the Jira projects you can see as slim rows { key, id, name, projectTypeKey } (maxResults defaults to 25); pass query to filter by name/key. The standard way to discover a projectKey for jira_create_issue or JQL.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    query: z.string().optional(),
    maxResults: z.number().default(25),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("maxResults", String(args.maxResults));
    if (args.query) params.set("query", args.query);
    const res = await ctx.http(`${BASE}/project/search?${params}`);
    const data = await res.json();
    return {
      projects: (data.values ?? []).map((p: any) => ({
        key: p.key,
        id: p.id,
        name: p.name,
        projectTypeKey: p.projectTypeKey,
      })),
      total: data.total,
      isLast: data.isLast,
    };
  },
};

export const getCreateMeta = {
  name: "jira_get_create_meta",
  description:
    "Return the fields required (and allowed) when creating a Jira issue. Pass projectKey and optionally issueType to scope the result. Each field entry includes { fieldId, name, required, schema, allowedValues } — use the fieldId as the key and an allowedValues entry's id/value as the value in jira_create_issue's fields arg.",
  integration: "atlassian-jira",
  inputSchema: z.object({
    projectKey: z.string(),
    issueType: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    // Fetch issue types for the project (returns their field schemas inline).
    const res = await ctx.http(`${BASE}/issue/createmeta/${args.projectKey}/issuetypes`);
    const data = await res.json();
    const issueTypes: any[] = data.issueTypes ?? data.values ?? [];

    const target = args.issueType
      ? issueTypes.filter((t: any) => t.name.toLowerCase() === args.issueType!.toLowerCase())
      : issueTypes;

    // For each matching issue type, fetch its field schema.
    const results = await Promise.all(
      target.map(async (issueType: any) => {
        const fr = await ctx.http(
          `${BASE}/issue/createmeta/${args.projectKey}/issuetypes/${issueType.id}`
        );
        const fd = await fr.json();
        const fields = (fd.fields ?? fd.values ?? []).map((f: any) => ({
          fieldId: f.fieldId,
          name: f.name,
          required: f.required,
          schema: f.schema,
          allowedValues: f.allowedValues?.map((v: any) => ({
            id: v.id,
            value: v.value ?? v.name,
          })),
        }));
        return { issueType: issueType.name, issueTypeId: issueType.id, fields };
      })
    );

    return results;
  },
};
