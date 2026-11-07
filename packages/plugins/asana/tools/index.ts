import { z } from "zod";

const API = "https://app.asana.com/api/1.0";

// opt_fields requested whenever we return a full task shape.
const TASK_OPT_FIELDS = "name,notes,completed,assignee.name,due_on,projects.name,permalink_url";

// Slim a raw Asana task (the object under `data`) to the fields agents need.
// Notes are truncated to 2000 chars to keep tool results small.
function slimTask(t: any) {
  const notes: string | undefined =
    typeof t.notes === "string" && t.notes.length > 2000 ? t.notes.slice(0, 2000) : t.notes;
  return {
    gid: t.gid,
    name: t.name,
    notes,
    completed: t.completed,
    assignee: t.assignee?.name ?? null,
    due_on: t.due_on ?? null,
    projects: (t.projects ?? []).map((p: any) => p.name),
    url: t.permalink_url,
  };
}

export const createTask = {
  name: "asana_create_task",
  description:
    "Create a new Asana task in a project. Returns the created task including its gid — keep the gid to update, complete (asana_update_task with completed:true), or comment on it later. dueOn is YYYY-MM-DD; assignee is a user gid (find one with asana_search_users).",
  integration: "asana",
  effect: "write",
  inputSchema: z.object({
    projectId: z.string(),
    name: z.string(),
    notes: z.string().optional(),
    assignee: z.string().optional(),
    dueOn: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const body: any = {
      data: {
        projects: [args.projectId],
        name: args.name,
        notes: args.notes,
      },
    };
    if (args.assignee) body.data.assignee = args.assignee;
    if (args.dueOn) body.data.due_on = args.dueOn;

    const res = await ctx.http(`${API}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return res.json();
  },
};

export const getTask = {
  name: "asana_get_task",
  description:
    "Read a single Asana task by gid — name, notes (truncated to 2000 chars), completed flag, assignee, due date, project names, and permalink URL. Use this to check current state before asana_update_task, or to follow up on a task created earlier. Cheaper and more complete than re-listing the whole project.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    taskGid: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("opt_fields", TASK_OPT_FIELDS);
    const res = await ctx.http(`${API}/tasks/${args.taskGid}?${params}`);
    const data = await res.json();
    return slimTask(data.data ?? {});
  },
};

export const updateTask = {
  name: "asana_update_task",
  description:
    "Update an Asana task — and the way to COMPLETE one: pass completed:true to mark it done (completed:false reopens it). Only the fields you provide are changed; omitted fields are left untouched. due_on is YYYY-MM-DD, assigneeGid is a user gid (asana_search_users). Returns the updated task in the same slim shape as asana_get_task.",
  integration: "asana",
  effect: "destructive",
  inputSchema: z.object({
    taskGid: z.string(),
    name: z.string().optional(),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
    assigneeGid: z.string().optional(),
    due_on: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    // Build the update payload from provided args only — Asana applies
    // exactly the keys present, so an absent key means "leave unchanged".
    const data: any = {};
    if (args.name !== undefined) data.name = args.name;
    if (args.notes !== undefined) data.notes = args.notes;
    if (args.completed !== undefined) data.completed = args.completed;
    if (args.assigneeGid !== undefined) data.assignee = args.assigneeGid;
    if (args.due_on !== undefined) data.due_on = args.due_on;

    const params = new URLSearchParams();
    params.set("opt_fields", TASK_OPT_FIELDS);
    const res = await ctx.http(`${API}/tasks/${args.taskGid}?${params}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data }),
    });
    const body = await res.json();
    return slimTask(body.data ?? {});
  },
};

export const addComment = {
  name: "asana_add_comment",
  description:
    "Add a comment (story) to an Asana task. Plain text only. Returns { gid, created_at } of the new comment. Use this for status updates or context on an existing task — to change task fields themselves use asana_update_task instead.",
  integration: "asana",
  effect: "write",
  inputSchema: z.object({
    taskGid: z.string(),
    text: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const res = await ctx.http(`${API}/tasks/${args.taskGid}/stories`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { text: args.text } }),
    });
    const body = await res.json();
    return { gid: body.data?.gid, created_at: body.data?.created_at };
  },
};

export const listTasks = {
  name: "asana_list_tasks",
  description:
    "List tasks in an Asana project as slim rows: { gid, name, completed, due_on, assignee } (default 10, set limit for more). Use asana_get_task on a gid when you need notes or the permalink. Find project gids with asana_list_projects.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    projectId: z.string(),
    limit: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("project", args.projectId);
    params.set("limit", String(args.limit));
    params.set("opt_fields", "name,completed,due_on,assignee.name");
    const res = await ctx.http(`${API}/tasks?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    return {
      tasks: body.data.map((t: any) => ({
        gid: t.gid,
        name: t.name,
        completed: t.completed,
        due_on: t.due_on ?? null,
        assignee: t.assignee?.name ?? null,
      })),
    };
  },
};

export const listProjects = {
  name: "asana_list_projects",
  description:
    "List Asana projects as slim rows: { gid, name } (default 10, set limit for more). Scope to one workspace via workspaceId, otherwise all workspaces you can see. Use the gid with asana_list_tasks / asana_create_task.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    workspaceId: z.string().optional(),
    limit: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    if (args.workspaceId) params.set("workspace", args.workspaceId);
    params.set("limit", String(args.limit));
    const res = await ctx.http(`${API}/projects?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    return { projects: body.data.map((p: any) => ({ gid: p.gid, name: p.name })) };
  },
};

export const listTeams = {
  name: "asana_list_teams",
  description:
    "List teams in an Asana organization as slim rows: { gid, name } (default 10, set limit for more). organizationId is the workspace gid of an organization.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    organizationId: z.string(),
    limit: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("organization", args.organizationId);
    params.set("limit", String(args.limit));
    const res = await ctx.http(`${API}/teams?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    return { teams: body.data.map((t: any) => ({ gid: t.gid, name: t.name })) };
  },
};

export const searchUsers = {
  name: "asana_search_users",
  description:
    "Search Asana users in a workspace as slim rows: { gid, name, email } (default 10, set limit for more). Omit query to list everyone. Use the gid as assignee / assigneeGid in asana_create_task and asana_update_task.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    workspaceId: z.string(),
    query: z.string().optional(),
    limit: z.number().default(10),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("workspace", args.workspaceId);
    if (args.query) params.set("search", args.query);
    params.set("limit", String(args.limit));
    params.set("opt_fields", "name,email");
    const res = await ctx.http(`${API}/users?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    return {
      users: body.data.map((u: any) => ({ gid: u.gid, name: u.name, email: u.email })),
    };
  },
};
