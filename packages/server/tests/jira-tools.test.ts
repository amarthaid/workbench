import { describe, it, expect, vi } from "vitest";
import {
  createIssue,
  searchIssues,
  getIssue,
  searchUsers,
  getBoards,
  getProjectTypes,
  updateIssue,
  getTransitions,
  transitionIssue,
  addComment,
  getComments,
  listProjects,
  getCreateMeta,
} from "../../plugins/atlassian-jira/tools/index";

// Mock ctx.http that records urls/bodies and replies with a canned payload.
function recordingCtx(jsonReply: unknown = {}, status = 200) {
  const urls: string[] = [];
  const bodies: string[] = [];
  const methods: (string | undefined)[] = [];
  const http = vi.fn(async (url: string, init?: any) => {
    urls.push(url);
    methods.push(init?.method);
    if (init?.body) bodies.push(init.body);
    return { status, json: async () => jsonReply };
  });
  return { ctx: { http } as any, urls, bodies, methods };
}

function param(url: string, name: string): string | null {
  return new URL(url).searchParams.get(name);
}

const adf = (text: string) => ({
  type: "doc",
  version: 1,
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

describe("jira_search_issues", () => {
  const upstream = {
    issues: [
      {
        id: "139262",
        key: "WB-1",
        fields: {
          summary: "Fix the loader",
          status: { name: "In Progress", id: "3" },
          assignee: { displayName: "Test User", accountId: "abc", avatarUrls: { "48x48": "x" } },
          priority: { name: "High", iconUrl: "y" },
          updated: "2026-06-12T10:00:00.000+0000",
        },
      },
    ],
    nextPageToken: "tok-2",
  };

  it("defaults the fields param when caller passes none", async () => {
    const { ctx, urls } = recordingCtx(upstream);
    await searchIssues.handler(ctx, { jql: "project = WB", maxResults: 10 });
    expect(param(urls[0], "fields")).toBe("summary,status,assignee,priority,updated");
    expect(param(urls[0], "jql")).toBe("project = WB");
    expect(param(urls[0], "maxResults")).toBe("10");
  });

  it("shapes rows to slim { key, id, summary, status, assignee, priority, updated } and keeps nextPageToken", async () => {
    const { ctx } = recordingCtx(upstream);
    const out: any = await searchIssues.handler(ctx, { jql: "project = WB", maxResults: 10 });
    expect(out.issues).toEqual([
      {
        key: "WB-1",
        id: "139262",
        summary: "Fix the loader",
        status: "In Progress",
        assignee: "Test User",
        priority: "High",
        updated: "2026-06-12T10:00:00.000+0000",
      },
    ]);
    expect(out.nextPageToken).toBe("tok-2");
    // no nested objects leak through
    expect(JSON.stringify(out)).not.toContain("avatarUrls");
    expect(JSON.stringify(out)).not.toContain("iconUrl");
  });

  it("passes caller-requested extra fields through raw under fields", async () => {
    const reply = {
      issues: [
        {
          id: "1",
          key: "WB-2",
          fields: { summary: "X", customfield_100: { value: "Sprint 9" } },
        },
      ],
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await searchIssues.handler(ctx, {
      jql: "x",
      maxResults: 5,
      fields: ["summary", "customfield_100"],
    });
    expect(param(urls[0], "fields")).toBe("summary,customfield_100");
    expect(out.issues[0].summary).toBe("X");
    expect(out.issues[0].fields).toEqual({ customfield_100: { value: "Sprint 9" } });
  });
});

describe("jira_get_issue", () => {
  it("shapes the issue and extracts plain text description from ADF", async () => {
    const reply = {
      id: "10",
      key: "WB-3",
      self: "https://api.atlassian.com/ex/jira/cid/rest/api/3/issue/10",
      fields: {
        summary: "Ship it",
        status: { name: "To Do" },
        assignee: { displayName: "A", avatarUrls: {} },
        reporter: { displayName: "B" },
        priority: { name: "Low" },
        issuetype: { name: "Task" },
        created: "c",
        updated: "u",
        labels: ["infra"],
        parent: { key: "WB-EPIC" },
        description: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: "First line" }] },
            { type: "paragraph", content: [{ type: "text", text: "Second line" }] },
          ],
        },
      },
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await getIssue.handler(ctx, { issueKey: "WB-3" });
    expect(urls[0]).toContain("/rest/api/3/issue/WB-3");
    expect(out).toMatchObject({
      key: "WB-3",
      id: "10",
      summary: "Ship it",
      status: "To Do",
      assignee: "A",
      reporter: "B",
      priority: "Low",
      issueType: "Task",
      labels: ["infra"],
      parent: "WB-EPIC",
      url: reply.self,
    });
    expect(out.description).toBe("First line\nSecond line");
    expect(JSON.stringify(out)).not.toContain("avatarUrls");
  });

  it("passes specific raw fields through when requested", async () => {
    const reply = { id: "1", key: "K", fields: { customfield_9: 42 } };
    const { ctx } = recordingCtx(reply);
    const out: any = await getIssue.handler(ctx, { issueKey: "K", fields: ["customfield_9"] });
    expect(out.fields).toEqual({ customfield_9: 42 });
  });
});

describe("jira_project_types", () => {
  it("strips the base64 icon and returns slim rows", async () => {
    const reply = [
      {
        key: "software",
        formattedKey: "Software",
        descriptionI18nKey: "jira.project.type.software.description",
        icon: "PHN2ZyB4bWxucz0i" + "QQ==".repeat(2000), // ~8KB base64 blob
        color: "#0052CC",
      },
    ];
    const { ctx } = recordingCtx(reply);
    const out: any = await getProjectTypes.handler(ctx, {});
    expect(out).toEqual([{ key: "software", formattedKey: "Software", type: undefined }]);
    const json = JSON.stringify(out);
    expect(json).not.toContain("PHN2ZyB");
    expect(json).not.toContain("descriptionI18nKey");
    expect(json.length).toBeLessThan(200);
  });
});

describe("jira_search_users", () => {
  it("drops avatarUrls and shapes rows", async () => {
    const reply = [
      {
        accountId: "acc-1",
        displayName: "Test User",
        emailAddress: "z@example.com",
        active: true,
        avatarUrls: { "16x16": "a", "24x24": "b", "32x32": "c", "48x48": "d" },
        timeZone: "Asia/Jakarta",
      },
    ];
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await searchUsers.handler(ctx, { query: "testuser", maxResults: 10 });
    expect(param(urls[0], "query")).toBe("testuser");
    expect(out).toEqual([
      { accountId: "acc-1", displayName: "Test User", emailAddress: "z@example.com", active: true },
    ]);
  });
});

describe("jira_get_boards", () => {
  it("shapes rows to { id, name, type, projectKey }", async () => {
    const reply = {
      values: [
        {
          id: 7,
          name: "WB board",
          type: "scrum",
          self: "https://x",
          location: { projectKey: "WB", projectId: 1, avatarURI: "blob" },
        },
      ],
      total: 1,
      isLast: true,
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await getBoards.handler(ctx, { maxResults: 50, startAt: 0 });
    expect(urls[0]).toContain("/rest/agile/1.0/board");
    expect(out.boards).toEqual([{ id: 7, name: "WB board", type: "scrum", projectKey: "WB" }]);
    expect(JSON.stringify(out)).not.toContain("avatarURI");
  });
});

describe("jira_update_issue", () => {
  it("builds fields from provided args only and wraps description in ADF", async () => {
    const { ctx, urls, bodies, methods } = recordingCtx({}, 204);
    const out: any = await updateIssue.handler(ctx, {
      issueKey: "WB-4",
      summary: "New summary",
      description: "Plain text body",
      labels: ["a", "b"],
    });
    expect(urls[0]).toContain("/rest/api/3/issue/WB-4");
    expect(methods[0]).toBe("PUT");
    const body = JSON.parse(bodies[0]);
    expect(body.fields.summary).toBe("New summary");
    expect(body.fields.description).toEqual(adf("Plain text body"));
    expect(body.fields.labels).toEqual(["a", "b"]);
    expect("assignee" in body.fields).toBe(false); // not provided → not sent
    expect(out).toEqual({ success: true });
  });

  it("maps assigneeAccountId to fields.assignee.accountId", async () => {
    const { ctx, bodies } = recordingCtx({}, 204);
    await updateIssue.handler(ctx, { issueKey: "WB-4", assigneeAccountId: "acc-9" });
    const body = JSON.parse(bodies[0]);
    expect(body.fields).toEqual({ assignee: { accountId: "acc-9" } });
  });
});

describe("jira_get_transitions / jira_transition_issue", () => {
  it("returns slim transitions with toStatus", async () => {
    const reply = {
      transitions: [
        { id: "11", name: "Start", to: { name: "In Progress", id: "3", iconUrl: "x" } },
        { id: "31", name: "Done", to: { name: "Done" } },
      ],
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await getTransitions.handler(ctx, { issueKey: "WB-5" });
    expect(urls[0]).toContain("/issue/WB-5/transitions");
    expect(out).toEqual([
      { id: "11", name: "Start", toStatus: "In Progress" },
      { id: "31", name: "Done", toStatus: "Done" },
    ]);
  });

  it("POSTs { transition: { id } } and maps 204 to success", async () => {
    const { ctx, urls, bodies, methods } = recordingCtx({}, 204);
    const out: any = await transitionIssue.handler(ctx, { issueKey: "WB-5", transitionId: "31" });
    expect(urls[0]).toContain("/issue/WB-5/transitions");
    expect(methods[0]).toBe("POST");
    expect(JSON.parse(bodies[0])).toEqual({ transition: { id: "31" } });
    expect(out).toEqual({ success: true });
  });
});

describe("jira_add_comment / jira_get_comments (ADF round-trip)", () => {
  it("wraps plain text in an ADF paragraph and returns { id, created }", async () => {
    const { ctx, urls, bodies } = recordingCtx({ id: "900", created: "2026-06-12", author: {}, body: {} });
    const out: any = await addComment.handler(ctx, { issueKey: "WB-6", body: "Looks good to me" });
    expect(urls[0]).toContain("/issue/WB-6/comment");
    expect(JSON.parse(bodies[0])).toEqual({ body: adf("Looks good to me") });
    expect(out).toEqual({ id: "900", created: "2026-06-12" });
  });

  it("extracts plain text back out of ADF comment bodies", async () => {
    const reply = {
      comments: [
        {
          id: "900",
          created: "2026-06-12",
          author: { displayName: "Test User", avatarUrls: {} },
          body: adf("Looks good to me"),
        },
      ],
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await getComments.handler(ctx, { issueKey: "WB-6", maxResults: 10 });
    expect(param(urls[0], "maxResults")).toBe("10");
    expect(out).toEqual([
      { id: "900", author: "Test User", body: "Looks good to me", created: "2026-06-12" },
    ]);
  });
});

describe("jira_create_issue", () => {
  it("posts standard fields and returns the API response", async () => {
    const reply = { id: "10001", key: "WB-1", self: "https://x" };
    const { ctx, urls, bodies, methods } = recordingCtx(reply);
    const out: any = await createIssue.handler(ctx, {
      projectKey: "WB",
      summary: "Fix login",
      description: "Steps to reproduce",
      issueType: "Bug",
    });
    expect(urls[0]).toContain("/rest/api/3/issue");
    expect(methods[0]).toBe("POST");
    const body = JSON.parse(bodies[0]);
    expect(body.fields.project).toEqual({ key: "WB" });
    expect(body.fields.summary).toBe("Fix login");
    expect(body.fields.description).toEqual(adf("Steps to reproduce"));
    expect(body.fields.issuetype).toEqual({ name: "Bug" });
    expect(out).toEqual(reply);
  });

  it("merges extra fields into the POST body", async () => {
    const { ctx, bodies } = recordingCtx({ id: "1", key: "WB-2", self: "x" });
    await createIssue.handler(ctx, {
      projectKey: "WB",
      summary: "Task",
      issueType: "Task",
      fields: { customfield_11153: { id: "11015" } },
    });
    const body = JSON.parse(bodies[0]);
    expect(body.fields.customfield_11153).toEqual({ id: "11015" });
    expect(body.fields.project).toEqual({ key: "WB" });
  });

  it("named args take precedence over conflicting keys in fields", async () => {
    const { ctx, bodies } = recordingCtx({ id: "1", key: "WB-3", self: "x" });
    await createIssue.handler(ctx, {
      projectKey: "WB",
      summary: "Real summary",
      issueType: "Task",
      fields: { summary: "Ignored", customfield_9: 99 },
    });
    const body = JSON.parse(bodies[0]);
    expect(body.fields.summary).toBe("Real summary");
    expect(body.fields.customfield_9).toBe(99);
  });

  it("omits description from body when not provided", async () => {
    const { ctx, bodies } = recordingCtx({ id: "1", key: "WB-4", self: "x" });
    await createIssue.handler(ctx, { projectKey: "WB", summary: "No desc", issueType: "Task" });
    const body = JSON.parse(bodies[0]);
    expect("description" in body.fields).toBe(false);
  });
});

describe("jira_get_create_meta", () => {
  it("fetches issue types then field schema per type and returns required fields with allowed values", async () => {
    const issueTypesReply = {
      issueTypes: [{ id: "10001", name: "Task" }],
    };
    const fieldsReply = {
      fields: [
        {
          fieldId: "summary",
          name: "Summary",
          required: true,
          schema: { type: "string" },
          allowedValues: undefined,
        },
        {
          fieldId: "customfield_11153",
          name: "Work Category",
          required: true,
          schema: { type: "option" },
          allowedValues: [
            { id: "11015", value: "NON KR: Support" },
            { id: "11016", value: "KR: Growth" },
          ],
        },
      ],
    };

    const callCount = { n: 0 };
    const ctx = {
      http: vi.fn(async (url: string) => {
        callCount.n++;
        if (url.includes("/issuetypes") && !url.includes("/10001")) {
          return { json: async () => issueTypesReply };
        }
        return { json: async () => fieldsReply };
      }),
    } as any;

    const out: any = await getCreateMeta.handler(ctx, { projectKey: "WB", issueType: "Task" });
    expect(out).toHaveLength(1);
    expect(out[0].issueType).toBe("Task");
    const wc = out[0].fields.find((f: any) => f.fieldId === "customfield_11153");
    expect(wc).toBeDefined();
    expect(wc.required).toBe(true);
    expect(wc.allowedValues).toEqual([
      { id: "11015", value: "NON KR: Support" },
      { id: "11016", value: "KR: Growth" },
    ]);
  });

  it("returns all issue types when issueType filter is omitted", async () => {
    const issueTypesReply = {
      issueTypes: [
        { id: "10001", name: "Task" },
        { id: "10002", name: "Bug" },
      ],
    };
    const ctx = {
      http: vi.fn(async (url: string) => {
        if (!url.match(/\/\d+$/)) return { json: async () => issueTypesReply };
        return { json: async () => ({ fields: [] }) };
      }),
    } as any;

    const out: any = await getCreateMeta.handler(ctx, { projectKey: "WB" });
    expect(out).toHaveLength(2);
    expect(out.map((r: any) => r.issueType)).toEqual(["Task", "Bug"]);
  });
});

describe("jira_update_issue (with custom fields)", () => {
  it("merges extra fields into PUT body while named args still take precedence", async () => {
    const { ctx, bodies, methods } = recordingCtx({}, 204);
    const out: any = await updateIssue.handler(ctx, {
      issueKey: "WB-9",
      summary: "Updated title",
      fields: { summary: "Ignored", customfield_11153: { id: "11016" } },
    });
    expect(methods[0]).toBe("PUT");
    const body = JSON.parse(bodies[0]);
    expect(body.fields.summary).toBe("Updated title");
    expect(body.fields.customfield_11153).toEqual({ id: "11016" });
    expect(out).toEqual({ success: true });
  });
});

describe("jira_list_projects", () => {
  it("shapes rows and forwards query/maxResults", async () => {
    const reply = {
      values: [
        {
          key: "WB",
          id: "10001",
          name: "Workbench",
          projectTypeKey: "software",
          avatarUrls: { "48x48": "x" },
          self: "https://x",
        },
      ],
      total: 1,
      isLast: true,
    };
    const { ctx, urls } = recordingCtx(reply);
    const out: any = await listProjects.handler(ctx, { query: "work", maxResults: 25 });
    expect(urls[0]).toContain("/rest/api/3/project/search");
    expect(param(urls[0], "query")).toBe("work");
    expect(param(urls[0], "maxResults")).toBe("25");
    expect(out.projects).toEqual([
      { key: "WB", id: "10001", name: "Workbench", projectTypeKey: "software" },
    ]);
    expect(JSON.stringify(out)).not.toContain("avatarUrls");
  });
});
