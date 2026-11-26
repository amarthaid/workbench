import { describe, it, expect, vi } from "vitest";
import {
  createTask,
  getTask,
  updateTask,
  listTasks,
  listSubtasks,
  listSections,
} from "../../plugins/asana/tools/index";

// Synthetic data only: field, project and option names are made up.

type Reply = unknown | ((url: string, init?: any) => unknown);

// A ctx.http that answers by URL and records every call.
function routedCtx(routes: Array<[RegExp, Reply]>) {
  const calls: { url: string; method: string; body: any }[] = [];
  const http = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined });
    for (const [re, reply] of routes) {
      if (re.test(url)) {
        const value = typeof reply === "function" ? (reply as any)(url, init) : reply;
        return { json: async () => value, status: 200 };
      }
    }
    throw new Error(`unrouted request: ${url}`);
  });
  return { ctx: { http } as any, calls };
}

const STATUS = {
  gid: "f1",
  name: "Status",
  type: "enum",
  enum_options: [
    { gid: "o1", name: "Not Started", enabled: true },
    { gid: "o2", name: "In Progress", enabled: true },
    { gid: "o9", name: "Retired", enabled: false },
  ],
};
const ETA = { gid: "f2", name: "PRD ETA ", type: "date" };
const HOURS = { gid: "f3", name: "Estimated Hours", type: "number" };
const TAGS = {
  gid: "f4",
  name: "Platform",
  type: "multi_enum",
  enum_options: [
    { gid: "p1", name: "Web", enabled: true },
    { gid: "p2", name: "Mobile", enabled: true },
  ],
};
const SECTIONS = { data: [{ gid: "s1", name: "Planning" }, { gid: "s2", name: "In Delivery" }] };

describe("reading custom fields, sections and start dates", () => {
  const task = {
    gid: "1",
    name: "Launch",
    start_on: "2026-12-01",
    due_on: "2026-12-20",
    projects: [{ name: "Roadmap" }],
    memberships: [{ project: { name: "Roadmap" }, section: { name: "In Delivery" } }, { project: { name: "Other" } }],
    custom_fields: [
      { name: "Status", type: "enum", enum_value: { name: "In Progress" } },
      { name: "Platform", type: "multi_enum", multi_enum_values: [{ name: "Web" }, { name: "Mobile" }] },
      { name: "Estimated Hours", type: "number", number_value: 12 },
      { name: "Notes ", type: "text", text_value: "ship it" },
      { name: "PRD ETA", type: "date", date_value: { date: "2026-12-15", date_time: null } },
      { name: "Owner", type: "people", people_value: [{ name: "Test User" }] },
      { name: "Priority", type: "enum", enum_value: null },
      { name: "Platform Notes", type: "text", text_value: "" },
    ],
  };

  it("get_task flattens every field type, drops empty fields, and reports start date and sections", async () => {
    const { ctx } = routedCtx([[/\/tasks\/1\?/, { data: task }]]);
    const result = await getTask.handler(ctx, { taskGid: "1" });
    expect(result.start_on).toBe("2026-12-01");
    expect(result.sections).toEqual([{ project: "Roadmap", section: "In Delivery" }]);
    expect(result.custom_fields).toEqual({
      Status: "In Progress",
      Platform: ["Web", "Mobile"],
      "Estimated Hours": 12,
      Notes: "ship it",
      "PRD ETA": "2026-12-15",
      Owner: ["Test User"],
    });
  });

  it("two fields with the same name both survive: the later one becomes 'Name (2)'", async () => {
    const { ctx } = routedCtx([
      [
        /\/tasks\/1\?/,
        {
          data: {
            gid: "1",
            custom_fields: [
              { name: "Status", type: "enum", enum_value: { name: "Done" } },
              { name: "Status", type: "enum", enum_value: { name: "Blocked" } },
            ],
          },
        },
      ],
    ]);
    const result = await getTask.handler(ctx, { taskGid: "1" });
    expect(result.custom_fields).toEqual({ Status: "Done", "Status (2)": "Blocked" });
  });

  it("falls back to display_value for a field type it does not know", async () => {
    const { ctx } = routedCtx([
      [/\/tasks\/1\?/, { data: { gid: "1", custom_fields: [{ name: "Mood", type: "emoji", display_value: "ok" }] } }],
    ]);
    expect((await getTask.handler(ctx, { taskGid: "1" })).custom_fields).toEqual({ Mood: "ok" });
  });

  it("list_tasks shows the section of the listed project, and pages with next_offset", async () => {
    const { ctx, calls } = routedCtx([
      [
        /\/tasks\?/,
        {
          data: [
            {
              gid: "1",
              name: "A",
              completed: false,
              start_on: "2026-12-01",
              memberships: [
                { project: { gid: "other" }, section: { name: "Wrong" } },
                { project: { gid: "p1" }, section: { name: "Planning" } },
              ],
              custom_fields: [{ name: "Status", type: "enum", enum_value: { name: "Not Started" } }],
            },
          ],
          next_page: { offset: "abc" },
        },
      ],
    ]);
    const result = await listTasks.handler(ctx, { projectId: "p1", limit: 10, offset: "prev" });
    expect(new URL(calls[0].url).searchParams.get("offset")).toBe("prev");
    expect(result.next_offset).toBe("abc");
    expect(result.tasks[0]).toMatchObject({ start_on: "2026-12-01", section: "Planning", custom_fields: { Status: "Not Started" } });
  });

  it("list_tasks omits next_offset on the last page", async () => {
    const { ctx } = routedCtx([[/\/tasks\?/, { data: [], next_page: null }]]);
    expect(await listTasks.handler(ctx, { projectId: "p1", limit: 10 })).toEqual({ tasks: [] });
  });
});

describe("asana_list_subtasks", () => {
  it("returns the dated phases with their custom fields and pages", async () => {
    const { ctx, calls } = routedCtx([
      [
        /\/tasks\/9\/subtasks/,
        {
          data: [
            {
              gid: "s1",
              name: "UAT",
              completed: false,
              assignee: { name: "Test User" },
              start_on: "2026-12-10",
              due_on: "2026-12-12",
              custom_fields: [{ name: "Status", type: "enum", enum_value: { name: "In Progress" } }],
            },
            { gid: "s2", name: "Release", completed: false },
          ],
          next_page: { offset: "next" },
        },
      ],
    ]);
    const result = await listSubtasks.handler(ctx, { taskGid: "9", limit: 25 });
    const u = new URL(calls[0].url);
    expect(u.searchParams.get("limit")).toBe("25");
    expect((u.searchParams.get("opt_fields") ?? "").split(",")).toEqual(expect.arrayContaining(["start_on", "due_on", "custom_fields.name"]));
    expect(result).toEqual({
      subtasks: [
        {
          gid: "s1",
          name: "UAT",
          completed: false,
          assignee: "Test User",
          start_on: "2026-12-10",
          due_on: "2026-12-12",
          custom_fields: { Status: "In Progress" },
        },
        { gid: "s2", name: "Release", completed: false, assignee: null, start_on: null, due_on: null, custom_fields: {} },
      ],
      next_offset: "next",
    });
  });

  it("passes an Asana error body through", async () => {
    const { ctx } = routedCtx([[/subtasks/, { errors: [{ message: "Not found" }] }]]);
    expect(await listSubtasks.handler(ctx, { taskGid: "x", limit: 25 })).toEqual({ errors: [{ message: "Not found" }] });
  });
});

describe("asana_list_sections", () => {
  it("returns gid and name in order", async () => {
    const { ctx, calls } = routedCtx([[/\/projects\/p1\/sections/, SECTIONS]]);
    expect(await listSections.handler(ctx, { projectId: "p1", limit: 50 })).toEqual({
      sections: [{ gid: "s1", name: "Planning" }, { gid: "s2", name: "In Delivery" }],
    });
    expect(new URL(calls[0].url).searchParams.get("opt_fields")).toBe("name");
  });
});

describe("asana_update_task writes", () => {
  const writeContext = {
    data: {
      custom_fields: [STATUS, ETA, HOURS, TAGS],
      memberships: [{ project: { gid: "p1", name: "Roadmap" } }],
    },
  };

  it("translates names to gids: enum option, date, number, multi-enum, clearing with null", async () => {
    const { ctx, calls } = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, writeContext],
      [/\/tasks\/42\?/, { data: { gid: "42", name: "T" } }],
    ]);
    await updateTask.handler(ctx, {
      taskGid: "42",
      start_on: "2026-12-01",
      customFields: {
        status: "in progress",
        "PRD ETA": "2026-12-15",
        "Estimated Hours": "8",
        Platform: ["Web", "Mobile"],
      },
    });
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.body).toEqual({
      data: {
        start_on: "2026-12-01",
        custom_fields: { f1: "o2", f2: { date: "2026-12-15" }, f3: 8, f4: ["p1", "p2"] },
      },
    });
  });

  it("clears a field and the start date with null", async () => {
    const { ctx, calls } = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, writeContext],
      [/\/tasks\/42\?/, { data: { gid: "42" } }],
    ]);
    await updateTask.handler(ctx, { taskGid: "42", start_on: null, customFields: { Status: null } });
    expect(calls.find((c) => c.method === "PUT")!.body).toEqual({ data: { start_on: null, custom_fields: { f1: null } } });
  });

  it("accepts a field gid as the key", async () => {
    const { ctx, calls } = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, writeContext],
      [/\/tasks\/42\?/, { data: { gid: "42" } }],
    ]);
    await updateTask.handler(ctx, { taskGid: "42", customFields: { f1: "Not Started" } });
    expect(calls.find((c) => c.method === "PUT")!.body.data.custom_fields).toEqual({ f1: "o1" });
  });

  it.each([
    [{ Statu: "Done" }, /No custom field "Statu".*Available: Status, PRD ETA, Estimated Hours, Platform/],
    [{ Status: "Nope" }, /"Nope" is not an option of "Status". Options: Not Started, In Progress\./],
    [{ Status: "Retired" }, /not an option/],
    [{ "PRD ETA": "next week" }, /YYYY-MM-DD/],
    [{ "Estimated Hours": "lots" }, /takes a number/],
    [{ Status: ["Not Started", "In Progress"] }, /single option/],
  ])("rejects %j before changing anything", async (customFields, message) => {
    const { ctx, calls } = routedCtx([[/\/tasks\/42\?opt_fields=custom_fields/, writeContext]]);
    await expect(updateTask.handler(ctx, { taskGid: "42", name: "x", customFields })).rejects.toThrow(message);
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("refuses an ambiguous name and asks for the gid", async () => {
    const twin = { gid: "f7", name: "Status ", type: "enum", enum_options: [{ gid: "x", name: "Done", enabled: true }] };
    const { ctx } = routedCtx([[/\/tasks\/42\?opt_fields=custom_fields/, { data: { custom_fields: [STATUS, twin], memberships: [] } }]]);
    await expect(updateTask.handler(ctx, { taskGid: "42", customFields: { Status: "Done" } })).rejects.toThrow(
      /matches 2 custom fields \(gids f1, f7\). Use the field gid/
    );
    // and the gid works
    const ok = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, { data: { custom_fields: [STATUS, twin], memberships: [] } }],
      [/\/tasks\/42\?/, { data: { gid: "42" } }],
    ]);
    await updateTask.handler(ok.ctx, { taskGid: "42", customFields: { f7: "Done" } });
    expect(ok.calls.find((c) => c.method === "PUT")!.body.data.custom_fields).toEqual({ f7: "x" });
  });

  it("moves a task to a named section in its only project, then returns it with the new section", async () => {
    const after = { data: { gid: "42", memberships: [{ project: { name: "Roadmap" }, section: { name: "In Delivery" } }] } };
    const { ctx, calls } = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, writeContext],
      [/\/projects\/p1\/sections/, SECTIONS],
      [/\/sections\/s2\/addTask/, { data: {} }],
      [/\/tasks\/42\?/, after],
    ]);
    const result = await updateTask.handler(ctx, { taskGid: "42", section: "in delivery" });
    const move = calls.find((c) => c.url.endsWith("/sections/s2/addTask"))!;
    expect(move.method).toBe("POST");
    expect(move.body).toEqual({ data: { task: "42" } });
    // Nothing else to change, so there is no PUT.
    expect(calls.some((c) => c.method === "PUT")).toBe(false);
    expect(result.sections).toEqual([{ project: "Roadmap", section: "In Delivery" }]);
  });

  it("needs projectId when the task is in several projects, and uses it when given", async () => {
    const two = {
      data: {
        custom_fields: [],
        memberships: [{ project: { gid: "p1", name: "Roadmap" } }, { project: { gid: "p2", name: "Backlog" } }],
      },
    };
    const refused = routedCtx([[/\/tasks\/42\?opt_fields=/, two]]);
    await expect(updateTask.handler(refused.ctx, { taskGid: "42", section: "Planning" })).rejects.toThrow(
      /in 2 projects \(Roadmap: p1, Backlog: p2\). Pass projectId/
    );

    const ok = routedCtx([
      [/\/tasks\/42\?opt_fields=memberships|\/tasks\/42\?opt_fields=custom_fields/, two],
      [/\/projects\/p2\/sections/, SECTIONS],
      [/\/sections\/s1\/addTask/, { data: {} }],
      [/\/tasks\/42\?/, { data: { gid: "42" } }],
    ]);
    await updateTask.handler(ok.ctx, { taskGid: "42", section: "Planning", projectId: "p2" });
    expect(ok.calls.some((c) => c.url.endsWith("/sections/s1/addTask"))).toBe(true);
  });

  it("an unknown section lists the valid ones and changes nothing", async () => {
    const { ctx, calls } = routedCtx([
      [/\/tasks\/42\?opt_fields=custom_fields/, writeContext],
      [/\/projects\/p1\/sections/, SECTIONS],
    ]);
    await expect(updateTask.handler(ctx, { taskGid: "42", name: "x", section: "Nope" })).rejects.toThrow(
      /No section "Nope" in project p1. Sections: Planning, In Delivery\./
    );
    expect(calls.some((c) => c.method !== "GET")).toBe(false);
  });

  it("reports Asana's rejection instead of returning an empty task", async () => {
    const { ctx } = routedCtx([[/\/tasks\/42\?/, { errors: [{ message: "start_on: invalid date" }] }]]);
    await expect(updateTask.handler(ctx, { taskGid: "42", start_on: "soon" })).rejects.toThrow(
      "asana update task: start_on: invalid date"
    );
  });

  it("does not look anything up when no custom fields or section are passed", async () => {
    const { ctx, calls } = routedCtx([[/\/tasks\/42\?/, { data: { gid: "42" } }]]);
    await updateTask.handler(ctx, { taskGid: "42", completed: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("PUT");
  });
});

describe("asana_create_task writes", () => {
  it("resolves custom fields from the project, creates with them, then places the task in its section", async () => {
    const { ctx, calls } = routedCtx([
      [/\/projects\/p1\?opt_fields=custom_field_settings/, { data: { custom_field_settings: [{ custom_field: STATUS }, { custom_field: ETA }] } }],
      [/\/projects\/p1\/sections/, SECTIONS],
      [/\/tasks$/, { data: { gid: "77", name: "New" } }],
      [/\/sections\/s1\/addTask/, { data: {} }],
    ]);
    const result = await createTask.handler(ctx, {
      projectId: "p1",
      name: "New",
      startOn: "2026-12-01",
      section: "Planning",
      customFields: { Status: "Not Started", "PRD ETA": "2026-12-15" },
    });
    const post = calls.find((c) => c.url.endsWith("/tasks"))!;
    expect(post.body).toEqual({
      data: {
        projects: ["p1"],
        name: "New",
        start_on: "2026-12-01",
        custom_fields: { f1: "o1", f2: { date: "2026-12-15" } },
      },
    });
    // Lookups come first and the move last.
    const order = calls.map((c) => (c.url.endsWith("/tasks") ? "create" : c.url.includes("addTask") ? "move" : "read"));
    expect(order[order.length - 1]).toBe("move");
    expect(order.indexOf("create")).toBeGreaterThan(order.lastIndexOf("read") - 1);
    expect(calls.find((c) => c.url.endsWith("/sections/s1/addTask"))!.body).toEqual({ data: { task: "77" } });
    expect(result).toEqual({ data: { gid: "77", name: "New" } });
  });

  it("a bad field name stops before the task is created", async () => {
    const { ctx, calls } = routedCtx([
      [/\/projects\/p1\?opt_fields=custom_field_settings/, { data: { custom_field_settings: [{ custom_field: STATUS }] } }],
    ]);
    await expect(createTask.handler(ctx, { projectId: "p1", name: "x", customFields: { Prio: "High" } })).rejects.toThrow(/No custom field "Prio"/);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("without the new options it behaves as before: one POST", async () => {
    const { ctx, calls } = routedCtx([[/\/tasks$/, { data: { gid: "1" } }]]);
    await createTask.handler(ctx, { projectId: "p1", name: "Plain", dueOn: "2026-12-20" });
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ data: { projects: ["p1"], name: "Plain", due_on: "2026-12-20" } });
  });
});
