import { z } from "zod";

const API = "https://app.asana.com/api/1.0";

// Custom field values, requested in the shapes Asana stores them: which of
// these carries the value depends on the field's type (see customFieldValue).
const CUSTOM_FIELD_OPT_FIELDS = [
  "custom_fields.name",
  "custom_fields.type",
  "custom_fields.display_value",
  "custom_fields.enum_value.name",
  "custom_fields.multi_enum_values.name",
  "custom_fields.number_value",
  "custom_fields.text_value",
  "custom_fields.date_value",
  "custom_fields.people_value.name",
].join(",");

// opt_fields requested whenever we return a full task shape.
const TASK_OPT_FIELDS = [
  "name,notes,completed,assignee.name,due_on,start_on,projects.name,permalink_url",
  "memberships.project.name,memberships.section.name",
  CUSTOM_FIELD_OPT_FIELDS,
].join(",");

// Phase subtasks (Development, UAT, Release...) carry the schedule, so they get
// dates and custom fields but not notes.
const SUBTASK_OPT_FIELDS = ["name,completed,assignee.name,start_on,due_on", CUSTOM_FIELD_OPT_FIELDS].join(",");

const LIST_TASK_OPT_FIELDS = [
  "name,completed,due_on,start_on,assignee.name",
  "memberships.project.gid,memberships.section.name",
  CUSTOM_FIELD_OPT_FIELDS,
].join(",");

// What a write needs to know about a task's custom fields and projects.
const FIELD_DEF_OPT_FIELDS = [
  "gid,name,type",
  "enum_options.gid,enum_options.name,enum_options.enabled",
].join(",");

// The value of one custom field, in plain JSON. Null when the field is empty.
function customFieldValue(f: any): unknown {
  switch (f.type) {
    case "enum":
      return f.enum_value?.name ?? null;
    case "multi_enum": {
      const names = (f.multi_enum_values ?? []).map((v: any) => v.name);
      return names.length > 0 ? names : null;
    }
    case "number":
      return f.number_value ?? null;
    case "text":
      return f.text_value ? f.text_value : null;
    case "date":
      return f.date_value?.date_time ?? f.date_value?.date ?? null;
    case "people": {
      const names = (f.people_value ?? []).map((v: any) => v.name);
      return names.length > 0 ? names : null;
    }
    default:
      return f.display_value ?? null;
  }
}

// { "Status": "In Progress", "Product Brief ETA": "2026-12-15" }. Empty fields
// are left out, which keeps rows small on projects with many unused fields.
// Two fields can share a name in one project; the later ones become "Name (2)".
function slimCustomFields(fields: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields ?? []) {
    const value = customFieldValue(f);
    if (value === null) continue;
    const base = String(f.name ?? "").trim() || "(unnamed)";
    let key = base;
    for (let n = 2; key in out; n++) key = `${base} (${n})`;
    out[key] = value;
  }
  return out;
}

// Every section the task sits in, one per project.
function slimSections(memberships: any[] | undefined): { project: string; section: string }[] {
  return (memberships ?? [])
    .filter((m: any) => m.section?.name)
    .map((m: any) => ({ project: m.project?.name ?? "", section: m.section.name }));
}

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
    start_on: t.start_on ?? null,
    due_on: t.due_on ?? null,
    projects: (t.projects ?? []).map((p: any) => p.name),
    sections: slimSections(t.memberships),
    custom_fields: slimCustomFields(t.custom_fields),
    url: t.permalink_url,
  };
}

// Parse a JSON reply and turn Asana's { errors: [...] } into a thrown error, so
// a rejected write is reported as a failure instead of an empty task.
async function asanaJson(res: any, label: string): Promise<any> {
  const body = await res.json();
  if (body && Array.isArray(body.errors) && body.errors.length > 0) {
    throw new Error(`${label}: ${body.errors[0].message ?? "Asana rejected the request"}`);
  }
  return body;
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();

interface FieldDef {
  gid: string;
  name: string;
  type: string;
  enum_options?: { gid: string; name: string; enabled?: boolean }[];
}

function fieldKeyError(key: string, defs: FieldDef[]): Error {
  const names = [...new Set(defs.map((d) => d.name.trim()))];
  return new Error(
    `No custom field "${key}" on this ${defs.length ? "task" : "task or project"}. Available: ${names.join(", ") || "none"}.`
  );
}

// A key is a field gid or a field name (case-insensitive, trimmed). Two fields
// can share a name, and then the caller has to use the gid.
function findField(defs: FieldDef[], key: string): FieldDef {
  const byGid = defs.find((d) => d.gid === key);
  if (byGid) return byGid;
  const matches = defs.filter((d) => norm(d.name) === norm(key));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw fieldKeyError(key, defs);
  throw new Error(
    `"${key}" matches ${matches.length} custom fields (gids ${matches.map((m) => m.gid).join(", ")}). Use the field gid as the key.`
  );
}

function findOption(def: FieldDef, value: unknown): string {
  const options = (def.enum_options ?? []).filter((o) => o.enabled !== false);
  const hit = options.find((o) => o.gid === String(value)) ?? options.find((o) => norm(o.name) === norm(value));
  if (!hit) {
    throw new Error(`"${String(value)}" is not an option of "${def.name.trim()}". Options: ${options.map((o) => o.name).join(", ")}.`);
  }
  return hit.gid;
}

// Turn a friendly value into what Asana's custom_fields write expects. null
// clears the field.
function encodeFieldValue(def: FieldDef, value: unknown): unknown {
  if (value === null) return null;
  const label = def.name.trim();
  const many = Array.isArray(value) ? value : [value];
  switch (def.type) {
    case "enum":
      if (Array.isArray(value)) throw new Error(`"${label}" takes a single option, not a list.`);
      return findOption(def, value);
    case "multi_enum":
      return many.map((v) => findOption(def, v));
    case "number": {
      const n = typeof value === "number" ? value : Number(value);
      if (!Number.isFinite(n) || value === "") throw new Error(`"${label}" takes a number, got ${JSON.stringify(value)}.`);
      return n;
    }
    case "text":
      return String(value);
    case "date": {
      const s = String(value);
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return { date: s };
      if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return { date_time: s };
      throw new Error(`"${label}" takes a date as YYYY-MM-DD, got ${JSON.stringify(value)}.`);
    }
    case "people":
      return many.map(String);
    default:
      throw new Error(`"${label}" is a ${def.type} field, which cannot be set from here.`);
  }
}

function buildCustomFields(defs: FieldDef[], input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const def = findField(defs, key);
    out[def.gid] = encodeFieldValue(def, value);
  }
  return out;
}

async function sectionGid(ctx: any, projectId: string, section: string): Promise<string> {
  const params = new URLSearchParams({ limit: "100", opt_fields: "name" });
  const res = await ctx.http(`${API}/projects/${projectId}/sections?${params}`);
  const body = await asanaJson(res, "asana sections");
  const sections: { gid: string; name: string }[] = body.data ?? [];
  const hit = sections.find((s) => s.gid === section) ?? sections.find((s) => norm(s.name) === norm(section));
  if (!hit) {
    throw new Error(`No section "${section}" in project ${projectId}. Sections: ${sections.map((s) => s.name).join(", ") || "none"}.`);
  }
  return hit.gid;
}

async function moveToSection(ctx: any, taskGid: string, sectionId: string): Promise<void> {
  const res = await ctx.http(`${API}/sections/${sectionId}/addTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: { task: taskGid } }),
  });
  await asanaJson(res, "asana move to section");
}

// The custom fields on a task plus the projects it is in, with each field's
// options: everything a write needs to translate names into gids.
async function taskWriteContext(ctx: any, taskGid: string): Promise<{ defs: FieldDef[]; projects: { gid: string; name: string }[] }> {
  const params = new URLSearchParams({
    opt_fields: [
      ...FIELD_DEF_OPT_FIELDS.split(",").map((f) => `custom_fields.${f}`),
      "memberships.project.gid",
      "memberships.project.name",
    ].join(","),
  });
  const res = await ctx.http(`${API}/tasks/${taskGid}?${params}`);
  const body = await asanaJson(res, "asana get task");
  const data = body.data ?? {};
  return {
    defs: (data.custom_fields ?? []) as FieldDef[],
    projects: (data.memberships ?? []).map((m: any) => m.project).filter((p: any) => p?.gid),
  };
}

// The custom fields a new task in a project can carry.
async function projectFieldDefs(ctx: any, projectId: string): Promise<FieldDef[]> {
  const params = new URLSearchParams({
    opt_fields: FIELD_DEF_OPT_FIELDS.split(",")
      .map((f) => `custom_field_settings.custom_field.${f}`)
      .join(","),
  });
  const res = await ctx.http(`${API}/projects/${projectId}?${params}`);
  const body = await asanaJson(res, "asana get project");
  return (body.data?.custom_field_settings ?? []).map((s: any) => s.custom_field).filter(Boolean) as FieldDef[];
}

const customFieldsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.null(), z.array(z.string())]))
  .optional()
  .describe(
    'Custom fields to set, keyed by field name (case-insensitive) or field gid, e.g. { "Status": "In Progress", "Estimated Hours": 8, "Release Date": "2026-12-15" }. Enum values are option names, multi-enum values a list of option names, dates YYYY-MM-DD, people a list of user gids. null clears a field. If two fields share a name, use the gid.'
  );

export const createTask = {
  name: "asana_create_task",
  description:
    "Create a new Asana task in a project. Returns the created task including its gid — keep the gid to update, complete (asana_update_task with completed:true), or comment on it later. dueOn and startOn are YYYY-MM-DD; assignee is a user gid (find one with asana_search_users). section is the name of a section in the project (asana_list_sections) to put the task in. customFields sets custom fields by name, as in asana_update_task.",
  integration: "asana",
  effect: "write",
  inputSchema: z.object({
    projectId: z.string(),
    name: z.string(),
    notes: z.string().optional(),
    assignee: z.string().optional(),
    dueOn: z.string().optional(),
    startOn: z.string().optional(),
    section: z.string().optional(),
    customFields: customFieldsSchema,
  }),
  handler: async (ctx: any, args: any) => {
    // Resolve names to gids before anything is written, so a typo in a field,
    // option or section name stops the call instead of leaving a half-made task.
    let customFields: Record<string, unknown> | undefined;
    if (args.customFields && Object.keys(args.customFields).length > 0) {
      customFields = buildCustomFields(await projectFieldDefs(ctx, args.projectId), args.customFields);
    }
    const section = args.section ? await sectionGid(ctx, args.projectId, args.section) : undefined;

    const body: any = {
      data: {
        projects: [args.projectId],
        name: args.name,
        notes: args.notes,
      },
    };
    if (args.assignee) body.data.assignee = args.assignee;
    if (args.dueOn) body.data.due_on = args.dueOn;
    if (args.startOn) body.data.start_on = args.startOn;
    if (customFields) body.data.custom_fields = customFields;

    const res = await ctx.http(`${API}/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const created = await asanaJson(res, "asana create task");
    if (section && created.data?.gid) await moveToSection(ctx, created.data.gid, section);
    return created;
  },
};

export const getTask = {
  name: "asana_get_task",
  description:
    "Read a single Asana task by gid — name, notes (truncated to 2000 chars), completed flag, assignee, start and due dates, project names, the section it is in per project, custom fields as { name: value } (Status, Priority, ETAs and so on; empty ones are left out), and permalink URL. Use this to check current state before asana_update_task, or to follow up on a task created earlier. For its dated phase subtasks use asana_list_subtasks.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    taskGid: z.string(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("opt_fields", TASK_OPT_FIELDS);
    const res = await ctx.http(`${API}/tasks/${args.taskGid}?${params}`);
    const data = await asanaJson(res, "asana get task");
    return slimTask(data.data ?? {});
  },
};

export const updateTask = {
  name: "asana_update_task",
  description:
    "Update an Asana task — and the way to COMPLETE one: pass completed:true to mark it done (completed:false reopens it). Only the fields you provide are changed; omitted fields are left untouched. due_on and start_on are YYYY-MM-DD (null clears start_on), assigneeGid is a user gid (asana_search_users). customFields sets custom fields by name, e.g. { \"Status\": \"In Progress\", \"PRD ETA\": \"2026-12-15\" }; section moves the task to a named section (asana_list_sections), and projectId says which project's section when the task is in several. Names that do not match are rejected before anything is changed, with the valid names in the message. Returns the updated task in the same slim shape as asana_get_task.",
  integration: "asana",
  effect: "destructive",
  inputSchema: z.object({
    taskGid: z.string(),
    name: z.string().optional(),
    notes: z.string().optional(),
    completed: z.boolean().optional(),
    assigneeGid: z.string().optional(),
    due_on: z.string().optional(),
    start_on: z.string().nullable().optional(),
    section: z.string().optional(),
    projectId: z.string().optional(),
    customFields: customFieldsSchema,
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
    if (args.start_on !== undefined) data.start_on = args.start_on;

    // Resolve names to gids first, so a bad name changes nothing.
    const wantsFields = args.customFields && Object.keys(args.customFields).length > 0;
    let section: string | undefined;
    if (wantsFields || args.section) {
      const { defs, projects } = await taskWriteContext(ctx, args.taskGid);
      if (wantsFields) data.custom_fields = buildCustomFields(defs, args.customFields);
      if (args.section) {
        let projectId = args.projectId as string | undefined;
        if (!projectId) {
          if (projects.length !== 1) {
            throw new Error(
              projects.length === 0
                ? "This task is in no project, so it has no sections."
                : `This task is in ${projects.length} projects (${projects.map((p) => `${p.name}: ${p.gid}`).join(", ")}). Pass projectId to say which section to use.`
            );
          }
          projectId = projects[0].gid;
        }
        section = await sectionGid(ctx, projectId, args.section);
      }
    }

    const params = new URLSearchParams();
    params.set("opt_fields", TASK_OPT_FIELDS);
    if (Object.keys(data).length > 0) {
      const res = await ctx.http(`${API}/tasks/${args.taskGid}?${params}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data }),
      });
      const body = await asanaJson(res, "asana update task");
      if (!section) return slimTask(body.data ?? {});
    }
    // The section move is its own call, so the task is read back afterwards to
    // show where it ended up.
    if (section) await moveToSection(ctx, args.taskGid, section);
    const res = await ctx.http(`${API}/tasks/${args.taskGid}?${params}`);
    return slimTask((await asanaJson(res, "asana get task")).data ?? {});
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
    "List tasks in an Asana project as slim rows: { gid, name, completed, start_on, due_on, assignee, section, custom_fields } (default 10, up to 100 per page). custom_fields is { name: value } with empty ones left out. When more remain the result has next_offset: pass it back as offset for the next page. Use asana_get_task on a gid when you need notes or the permalink, and asana_list_subtasks for its dated phases. Find project gids with asana_list_projects.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    projectId: z.string(),
    limit: z.number().default(10),
    offset: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("project", args.projectId);
    params.set("limit", String(args.limit));
    if (args.offset) params.set("offset", args.offset);
    params.set("opt_fields", LIST_TASK_OPT_FIELDS);
    const res = await ctx.http(`${API}/tasks?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    const out: any = {
      tasks: body.data.map((t: any) => ({
        gid: t.gid,
        name: t.name,
        completed: t.completed,
        start_on: t.start_on ?? null,
        due_on: t.due_on ?? null,
        assignee: t.assignee?.name ?? null,
        // The section within the project that was asked for; a task in other
        // projects too has memberships there as well.
        section: (t.memberships ?? []).find((m: any) => m.project?.gid === args.projectId)?.section?.name ?? null,
        custom_fields: slimCustomFields(t.custom_fields),
      })),
    };
    if (body.next_page?.offset) out.next_offset = body.next_page.offset;
    return out;
  },
};

export const listSubtasks = {
  name: "asana_list_subtasks",
  description:
    "List the subtasks of an Asana task as slim rows: { gid, name, completed, assignee, start_on, due_on, custom_fields }. Teams often model delivery phases (Development, UAT, E2E, Release, GTM) as dated subtasks, so this is where those schedules are. Default 25, up to 100 per page; when more remain the result has next_offset: pass it back as offset.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    taskGid: z.string(),
    limit: z.number().default(25),
    offset: z.string().optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("limit", String(args.limit));
    if (args.offset) params.set("offset", args.offset);
    params.set("opt_fields", SUBTASK_OPT_FIELDS);
    const res = await ctx.http(`${API}/tasks/${args.taskGid}/subtasks?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    const out: any = {
      subtasks: body.data.map((t: any) => ({
        gid: t.gid,
        name: t.name,
        completed: t.completed,
        assignee: t.assignee?.name ?? null,
        start_on: t.start_on ?? null,
        due_on: t.due_on ?? null,
        custom_fields: slimCustomFields(t.custom_fields),
      })),
    };
    if (body.next_page?.offset) out.next_offset = body.next_page.offset;
    return out;
  },
};

export const listSections = {
  name: "asana_list_sections",
  description:
    "List the sections of an Asana project, in board order, as slim rows: { gid, name }. Teams often use sections for team or stage, and asana_list_tasks shows each task's section. Use a name as section in asana_create_task / asana_update_task to place or move a task.",
  integration: "asana",
  effect: "read",
  inputSchema: z.object({
    projectId: z.string(),
    limit: z.number().default(50),
  }),
  handler: async (ctx: any, args: any) => {
    const params = new URLSearchParams();
    params.set("limit", String(args.limit));
    params.set("opt_fields", "name");
    const res = await ctx.http(`${API}/projects/${args.projectId}/sections?${params}`);
    const body = await res.json();
    if (!Array.isArray(body.data)) return body;
    return { sections: body.data.map((s: any) => ({ gid: s.gid, name: s.name })) };
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
