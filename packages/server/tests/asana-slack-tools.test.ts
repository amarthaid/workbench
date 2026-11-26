import { describe, it, expect, vi } from "vitest";
import { getTask, updateTask, addComment, listTasks } from "../../plugins/asana/tools/index";
import { updateMessage, deleteMessage, listUsers } from "../../plugins/slack/tools/index";

// Mock ctx.http that records urls + parsed JSON bodies.
function recordingCtx(jsonReply: unknown = {}) {
  const urls: string[] = [];
  const bodies: any[] = [];
  const http = vi.fn(async (url: string, init?: any) => {
    urls.push(url);
    if (init?.body) bodies.push(JSON.parse(init.body));
    return { json: async () => jsonReply, status: 200 };
  });
  return { ctx: { http } as any, urls, bodies, http };
}

describe("asana_update_task", () => {
  it("builds data from provided args only — completed:true alone sends just {completed:true}", async () => {
    const { ctx, bodies, http } = recordingCtx({ data: { gid: "42", completed: true } });
    await updateTask.handler(ctx, { taskGid: "42", completed: true });
    expect(bodies[0]).toEqual({ data: { completed: true } });
    const [url, init] = http.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(url).toContain("/tasks/42");
  });

  it("includes only the fields that were passed", async () => {
    const { ctx, bodies } = recordingCtx({ data: { gid: "42" } });
    await updateTask.handler(ctx, { taskGid: "42", name: "New name", due_on: "2026-07-01" });
    expect(bodies[0]).toEqual({ data: { name: "New name", due_on: "2026-07-01" } });
  });

  it("maps assigneeGid to assignee and returns the slim task shape", async () => {
    const { ctx, bodies } = recordingCtx({
      data: {
        gid: "42",
        name: "T",
        notes: "n",
        completed: false,
        assignee: { name: "Test User" },
        due_on: "2026-07-01",
        projects: [{ name: "P1" }],
        permalink_url: "https://app.asana.com/0/1/42",
      },
    });
    const result = await updateTask.handler(ctx, { taskGid: "42", assigneeGid: "u9" });
    expect(bodies[0]).toEqual({ data: { assignee: "u9" } });
    expect(result).toEqual({
      gid: "42",
      name: "T",
      notes: "n",
      completed: false,
      assignee: "Test User",
      start_on: null,
      due_on: "2026-07-01",
      projects: ["P1"],
      sections: [],
      custom_fields: {},
      url: "https://app.asana.com/0/1/42",
    });
  });
});

describe("asana_get_task", () => {
  it("requests the slim opt_fields set", async () => {
    const { ctx, urls } = recordingCtx({ data: { gid: "7" } });
    await getTask.handler(ctx, { taskGid: "7" });
    const u = new URL(urls[0]);
    expect(u.pathname).toBe("/api/1.0/tasks/7");
    const fields = (u.searchParams.get("opt_fields") ?? "").split(",");
    for (const f of [
      "name", "notes", "completed", "assignee.name", "due_on", "start_on", "projects.name", "permalink_url",
      "memberships.section.name", "custom_fields.name", "custom_fields.enum_value.name", "custom_fields.date_value",
    ]) {
      expect(fields).toContain(f);
    }
  });

  it("truncates notes to 2000 chars", async () => {
    const { ctx } = recordingCtx({ data: { gid: "7", notes: "x".repeat(5000) } });
    const result = await getTask.handler(ctx, { taskGid: "7" });
    expect(result.notes).toHaveLength(2000);
  });
});

describe("asana_add_comment", () => {
  it("POSTs { data: { text } } to /tasks/{gid}/stories and returns { gid, created_at }", async () => {
    const { ctx, urls, bodies, http } = recordingCtx({
      data: { gid: "story1", created_at: "2026-06-12T00:00:00Z", text: "hi" },
    });
    const result = await addComment.handler(ctx, { taskGid: "42", text: "hi" });
    expect(urls[0]).toContain("/tasks/42/stories");
    expect(http.mock.calls[0][1].method).toBe("POST");
    expect(bodies[0]).toEqual({ data: { text: "hi" } });
    expect(result).toEqual({ gid: "story1", created_at: "2026-06-12T00:00:00Z" });
  });
});

describe("asana_list_tasks shaping", () => {
  it("returns slim rows and requests opt_fields", async () => {
    const { ctx, urls } = recordingCtx({
      data: [
        { gid: "1", name: "A", completed: false, due_on: "2026-07-01", assignee: { name: "Z" }, extra: "junk" },
        { gid: "2", name: "B", completed: true, assignee: null },
      ],
    });
    const result = await listTasks.handler(ctx, { projectId: "p1", limit: 10 });
    const fields = (new URL(urls[0]).searchParams.get("opt_fields") ?? "").split(",");
    for (const f of ["name", "completed", "due_on", "start_on", "assignee.name", "memberships.section.name", "custom_fields.name"]) {
      expect(fields).toContain(f);
    }
    expect(result).toEqual({
      tasks: [
        { gid: "1", name: "A", completed: false, start_on: null, due_on: "2026-07-01", assignee: "Z", section: null, custom_fields: {} },
        { gid: "2", name: "B", completed: true, start_on: null, due_on: null, assignee: null, section: null, custom_fields: {} },
      ],
    });
  });
});

describe("slack_update_message", () => {
  it("POSTs { channel, ts, text } to chat.update and returns { ok, ts }", async () => {
    const { ctx, urls, bodies } = recordingCtx({ ok: true, ts: "123.456", channel: "C1", text: "edited" });
    const result = await updateMessage.handler(ctx, { channel: "C1", ts: "123.456", text: "edited" });
    expect(urls[0]).toBe("https://slack.com/api/chat.update");
    expect(bodies[0]).toEqual({ channel: "C1", ts: "123.456", text: "edited" });
    expect(result).toEqual({ ok: true, ts: "123.456" });
  });

  it("passes through Slack's {ok:false} error body", async () => {
    const { ctx } = recordingCtx({ ok: false, error: "message_not_found" });
    const result = await updateMessage.handler(ctx, { channel: "C1", ts: "9.9", text: "x" });
    expect(result).toEqual({ ok: false, error: "message_not_found" });
  });
});

describe("slack_delete_message", () => {
  it("POSTs { channel, ts } to chat.delete and returns { ok, ts }", async () => {
    const { ctx, urls, bodies } = recordingCtx({ ok: true, ts: "123.456", channel: "C1" });
    const result = await deleteMessage.handler(ctx, { channel: "C1", ts: "123.456" });
    expect(urls[0]).toBe("https://slack.com/api/chat.delete");
    expect(bodies[0]).toEqual({ channel: "C1", ts: "123.456" });
    expect(result).toEqual({ ok: true, ts: "123.456" });
  });

  it("passes through Slack's {ok:false} error body", async () => {
    const { ctx } = recordingCtx({ ok: false, error: "cant_delete_message" });
    const result = await deleteMessage.handler(ctx, { channel: "C1", ts: "9.9" });
    expect(result).toEqual({ ok: false, error: "cant_delete_message" });
  });
});

describe("slack_list_users shaping", () => {
  it("strips avatar URLs and keeps id/name/real_name/email/is_bot/deleted", async () => {
    const { ctx } = recordingCtx({
      ok: true,
      members: [
        {
          id: "U1",
          name: "testuser",
          real_name: "Test User",
          is_bot: false,
          deleted: false,
          profile: {
            email: "z@example.com",
            image_24: "https://a/24.png",
            image_48: "https://a/48.png",
            image_72: "https://a/72.png",
            image_192: "https://a/192.png",
            status_text: "afk",
          },
        },
      ],
      response_metadata: { next_cursor: "abc" },
    });
    const result = await listUsers.handler(ctx, { limit: 100 });
    expect(result.members).toEqual([
      {
        id: "U1",
        name: "testuser",
        real_name: "Test User",
        email: "z@example.com",
        is_bot: false,
        deleted: false,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("image_");
    expect(result.next_cursor).toBe("abc");
  });
});
