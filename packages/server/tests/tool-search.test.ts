import { describe, it, expect, beforeAll } from "vitest";
import { corrections, editDistance, rankTools, stem, tokenize } from "../src/plugins/search";
import { loadPlugins } from "../src/plugins/loader";
import { registry } from "../src/plugins/registry";

const tool = (name: string, description: string, integration = name.split("_")[0]) => ({
  name,
  description,
  integration,
});

describe("tokenize", () => {
  it("splits snake_case, camelCase and punctuation, drops stop words, stems", () => {
    expect(tokenize("jira_create_issue")).toEqual(["jira", "creat", "issu"]);
    expect(tokenize("getPullRequests for the repo")).toEqual(["get", "pr", "repo"]);
    expect(tokenize("Open a merge-request")).toEqual(["open", "mr"]);
  });

  it("folds the forms of one word together", () => {
    expect(new Set(["update", "updates", "updated", "updating"].map(stem))).toEqual(new Set(["updat"]));
    expect(stem("prs")).toBe("pr");
    expect(stem("status")).toBe("status");
    expect(stem("entries")).toBe("entry");
  });
});

describe("editDistance", () => {
  it("counts a transposition as one edit", () => {
    expect(editDistance("emial", "email", 1)).toBe(1);
    expect(editDistance("slakc", "slack", 1)).toBe(1);
  });

  it("gives up past the cap", () => {
    expect(editDistance("github", "gitlab", 1)).toBe(2);
    expect(editDistance("a", "abcdef", 2)).toBe(3);
  });
});

describe("corrections", () => {
  const vocab = new Map([
    ["email", 5],
    ["gmail", 9],
    ["github", 20],
    ["gitlab", 20],
    ["jira", 12],
    ["calendar", 3],
  ]);

  it("corrects an unknown word to the nearest known one", () => {
    expect(corrections("emial", vocab)).toEqual(["email"]);
    expect(corrections("jria", vocab)).toEqual(["jira"]);
    expect(corrections("gihtub", vocab)).toEqual(["github"]);
  });

  it("keeps both when two known words are equally close", () => {
    // one substitution from each: l→h (github), u→a (gitlab)
    expect(corrections("gitlub", vocab).sort()).toEqual(["github", "gitlab"]);
  });

  it("allows two edits only for long words", () => {
    expect(corrections("calandr", vocab)).toEqual([]);
    expect(corrections("calandarr", vocab)).toEqual(["calendar"]);
  });

  it("leaves known words, prefixes and short words alone", () => {
    expect(corrections("gitlab", vocab)).toEqual([]);
    expect(corrections("calend", vocab)).toEqual([]);
    expect(corrections("jir", vocab)).toEqual([]);
  });

  it("returns nothing past the edit budget", () => {
    expect(corrections("kubernetes", vocab)).toEqual([]);
  });
});

describe("rankTools", () => {
  const tools = [
    tool("jira_create_issue", "Create a Jira issue and return its key."),
    tool("jira_get_issue", "Get one Jira issue by key, with created and updated dates."),
    tool("github_create_issue", "Open a new issue in a GitHub repository."),
    tool("github_list_prs", "List pull requests in a GitHub repository."),
    tool("github_list_pr_comments", "List comments on a pull request."),
    tool("google_gmail_send", "Send an email from the user's Gmail account.", "google-gmail"),
    tool("slack_send_message", "Post a message to a Slack channel."),
    tool("vision_create_access_request", "Request access to systems such as jira or vpn."),
  ];

  it("matches words in any order, not the phrase", () => {
    expect(rankTools(tools, "create jira issue")[0].tool.name).toBe("jira_create_issue");
    expect(rankTools(tools, "issue create jira")[0].tool.name).toBe("jira_create_issue");
  });

  it("tolerates a typo", () => {
    expect(rankTools(tools, "send emial")[0].tool.name).toBe("google_gmail_send");
    expect(rankTools(tools, "creat jria issue")[0].tool.name).toBe("jira_create_issue");
  });

  it("carries a corrected word through synonyms, a little below the right spelling", () => {
    // emial → email → gmail, so the typo reaches the tool name too
    const typo = rankTools(tools, "send emial")[0].score;
    const right = rankTools(tools, "send email")[0].score;
    expect(typo).toBeLessThan(right);
    expect(typo).toBeGreaterThan(right * 0.5);
  });

  it("matches a prefix", () => {
    expect(rankTools(tools, "gmai")[0].tool.name).toBe("google_gmail_send");
  });

  it("uses synonyms", () => {
    expect(rankTools(tools, "new jira ticket")[0].tool.name).toBe("jira_create_issue");
    expect(rankTools(tools, "list github pull requests")[0].tool.name).toBe("github_list_prs");
  });

  it("ranks a name match above a passing mention in a description", () => {
    const names = rankTools(tools, "jira").map((r) => r.tool.name);
    expect(names.indexOf("vision_create_access_request")).toBeGreaterThan(names.indexOf("jira_get_issue"));
  });

  it("returns scores best first and honours the limit", () => {
    const r = rankTools(tools, "issue", 2);
    expect(r).toHaveLength(2);
    expect(r[0].score).toBeGreaterThanOrEqual(r[1].score);
    expect(r[1].score).toBeGreaterThan(0);
  });

  it("returns nothing for no match, an empty query, or only stop words", () => {
    expect(rankTools(tools, "kubernetes")).toEqual([]);
    expect(rankTools(tools, "")).toEqual([]);
    expect(rankTools(tools, "the of to")).toEqual([]);
  });

  it("puts an exact tool name first", () => {
    expect(rankTools(tools, "github_list_pr_comments")[0].tool.name).toBe("github_list_pr_comments");
  });
});

// Agent phrasings against the real built-in catalog: each must put the right
// tool first. A miss here means the ranking or a tool description regressed.
describe("rankTools over the built-in catalog", () => {
  beforeAll(async () => {
    await loadPlugins();
  });

  it.each([
    ["create jira issue", "jira_create_issue"],
    ["send emial", "google_gmail_send"],
    ["send email", "google_gmail_send"],
    ["list github pull requests", "github_list_prs"],
    ["post slack message", "slack_send_message"],
    ["move ticket to done", "jira_transition_issue"],
    ["upload file to drive", "google_drive_upload"],
    ["screenshot page", "browser_screenshot"],
    ["search confluence pages", "confluence_search_pages"],
    ["read google sheet", "google_sheets_read"],
    ["spreadsheet append row", "google_sheets_append"],
    ["browser_navigate", "browser_navigate"],
    // typos
    ["create jria issue", "jira_create_issue"],
    ["slakc send message", "slack_send_message"],
    ["search confluance pages", "confluence_search_pages"],
    ["uplaod file to drive", "google_drive_upload"],
    ["read gogle sheet", "google_sheets_read"],
  ])("%s → %s", (query, expected) => {
    expect(rankTools(registry.listTools(), query)[0]?.tool.name).toBe(expected);
  });
});
