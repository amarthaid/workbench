---
title: Tool catalog
description: Every tool a stock install loads — 194 plugin tools across 16 integrations, plus 12 built-in tools.
---

A stock install registers **206 tools**: 194 from the 16 built-in plugins, plus 9
browser tools and 3 jots tools from the two internal plugins.

None of them appear in MCP `tools/list` — that returns only the
[nine meta-tools](meta-tools.md). Find a tool here or with `search_tools`, fetch its
arguments with `get_tool_schema`, and run it with `execute_tools`.

| Integration | Auth | Curl proxy | Tools |
|---|---|---|---|
| [`asana`](../integrations/asana.md) | oauth2 | yes | 8 |
| [`atlassian-bitbucket`](../integrations/atlassian-bitbucket.md) | oauth2 | yes | 20 |
| [`atlassian-confluence`](../integrations/atlassian-confluence.md) | oauth2 | yes | 6 |
| [`atlassian-jira`](../integrations/atlassian-jira.md) | oauth2 | yes | 12 |
| [`github`](../integrations/github.md) | oauth2 | yes | 28 |
| [`gitlab`](../integrations/gitlab.md) | oauth2 + instance | yes | 31 |
| `google-calendar` | oauth2 | yes | 7 |
| `google-docs` | oauth2 | yes | 5 |
| `google-drive` | oauth2 | yes | 8 |
| `google-gemini` | oauth2 | yes | 1 |
| `google-gmail` | oauth2 | yes | 8 |
| `google-sheets` | oauth2 | yes | 5 |
| `google-slides` | oauth2 | yes | 5 |
| `httpbin-cookie` | cookie | no | 3 |
| [`newrelic`](../integrations/newrelic.md) | apikey | yes | 13 |
| [`slack`](../integrations/slack.md) | oauth2 | yes | 18 |
| [`browser`](../integrations/browser.md) | none (internal) | no | 9 |
| [`jots`](../integrations/jots.md) | none (internal) | no | 3 |

Tool names are a flat global namespace across every plugin, so a later-loaded plugin
silently wins a name collision. Prefix your own tools with your integration name.

## asana

| Tool | Purpose |
|---|---|
| `asana_create_task` | Create a task in a project; returns its gid |
| `asana_get_task` | Read one task by gid |
| `asana_update_task` | Update fields; `completed: true` is how you close a task |
| `asana_add_comment` | Add a story (comment) to a task |
| `asana_list_tasks` | Slim task rows for a project |
| `asana_list_projects` | Slim project rows |
| `asana_list_teams` | Slim team rows for an organization |
| `asana_search_users` | Resolve user gids for assignment |

## atlassian-bitbucket

| Tool | Purpose |
|---|---|
| `bitbucket_list_repos` | Slim repo rows for a workspace |
| `bitbucket_get_repo` | One repo plus its https clone URL |
| `bitbucket_create_pr` | Open a PR; upserts an existing PR from the same source branch, and filters the author out of reviewers |
| `bitbucket_list_prs` | Slim PR rows, `OPEN` by default |
| `bitbucket_get_pr` | One PR including reviewer approval status |
| `bitbucket_get_pr_diff` | Diffstat rows, or the full unified diff |
| `bitbucket_list_pr_comments` | PR comments including inline `{path, line}` |
| `bitbucket_add_pr_comment` | Add a general or inline PR comment |
| `bitbucket_approve_pr` | Approve as the connected user |
| `bitbucket_request_changes` | Mark the PR as changes-requested |
| `bitbucket_merge_pr` | Merge into the destination branch — irreversible |
| `bitbucket_decline_pr` | Close the PR without merging |
| `bitbucket_get_file` | Raw file text at a ref |
| `bitbucket_list_pr_commits` | Slim commit rows for a PR |
| `bitbucket_trigger_pipeline` | Start a Pipelines run on a branch |
| `bitbucket_get_pipeline` | Poll one pipeline run |
| `bitbucket_stop_pipeline` | Stop a running pipeline |
| `bitbucket_get_clone_url` | Mint a token-embedded clone URL |
| `bitbucket_list_default_reviewers` | Reviewers that auto-attach to new PRs |
| `bitbucket_search_users` | Resolve user UUIDs |

## atlassian-confluence

| Tool | Purpose |
|---|---|
| `confluence_create_page` | Create a page in a space |
| `confluence_search_pages` | CQL full-text search |
| `confluence_get_page` | Page body, version, space, and attachments |
| `confluence_list_spaces` | List spaces |
| `confluence_update_page` | Update a page — takes the current version number |
| `confluence_delete_page` | Move a page to the space trash |

## atlassian-jira

| Tool | Purpose |
|---|---|
| `jira_create_issue` | Create an issue |
| `jira_search_issues` | JQL search; slim rows plus a page token |
| `jira_get_issue` | One issue in full |
| `jira_search_users` | Resolve account IDs |
| `jira_get_boards` | List Agile boards |
| `jira_project_types` | Project types, with base64 icons stripped |
| `jira_update_issue` | Update issue fields |
| `jira_get_transitions` | Transitions available from the current status |
| `jira_transition_issue` | Move an issue to a new status |
| `jira_add_comment` | Comment on an issue |
| `jira_get_comments` | Comments, converted from ADF to plain text |
| `jira_list_projects` | List projects |

## github

| Tool | Purpose |
|---|---|
| `github_list_repos` | List repositories |
| `github_get_repo` | One repository |
| `github_list_branches` | List branches |
| `github_list_commits` | List commits |
| `github_list_releases` | List releases |
| `github_get_content` | File contents (base64 + sha) or a directory listing |
| `github_create_issue` | Create an issue |
| `github_list_issues` | List issues |
| `github_get_issue` | One issue |
| `github_update_issue` | Update an issue |
| `github_add_issue_comment` | Comment on an issue |
| `github_create_pr` | Open a pull request |
| `github_list_prs` | List pull requests |
| `github_get_pr` | One pull request |
| `github_get_pr_diff` | The PR diff |
| `github_list_pr_comments` | PR review comments |
| `github_add_pr_comment` | Comment on a PR |
| `github_merge_pr` | Merge a PR |
| `github_create_pr_review` | Submit a review — `APPROVE`, `REQUEST_CHANGES`, or `COMMENT` |
| `github_create_or_update_file` | Commit a file directly |
| `github_search_code` | Code search |
| `github_search_issues` | Issue and PR search |
| `github_list_workflow_runs` | List Actions runs |
| `github_trigger_workflow` | `workflow_dispatch` a workflow |
| `github_get_workflow_run` | Poll one run |
| `github_rerun_workflow_run` | Re-run a workflow run |
| `github_cancel_workflow_run` | Cancel a running workflow |
| `github_get_clone_url` | Mint a token-embedded clone URL |

> [!NOTE] `github_trigger_workflow` returns no run id
> `workflow_dispatch` answers 204 with no body. The workflow must declare
> `on: workflow_dispatch`, and you have to poll `github_list_workflow_runs` to find
> the run you started.

## gitlab

Every GitLab tool builds its base URL from the connection's `instanceUrl`, defaulting
to `https://gitlab.com` — the same tools work against a self-hosted instance.

| Tool | Purpose |
|---|---|
| `gitlab_list_projects` | List projects |
| `gitlab_get_project` | One project |
| `gitlab_list_branches` | List branches |
| `gitlab_list_commits` | List commits |
| `gitlab_list_releases` | List releases |
| `gitlab_get_file` | Read a file at a ref |
| `gitlab_create_or_update_file` | Commit a file directly |
| `gitlab_create_issue` | Create an issue |
| `gitlab_list_issues` | List issues |
| `gitlab_get_issue` | One issue |
| `gitlab_update_issue` | Update an issue |
| `gitlab_add_issue_comment` | Comment on an issue |
| `gitlab_create_mr` | Open a merge request |
| `gitlab_list_mrs` | List merge requests |
| `gitlab_get_mr` | One merge request |
| `gitlab_get_mr_diff` | The MR diff |
| `gitlab_list_mr_commits` | Commits in an MR |
| `gitlab_list_mr_comments` | MR notes |
| `gitlab_add_mr_comment` | Comment on an MR |
| `gitlab_approve_mr` | Approve an MR |
| `gitlab_merge_mr` | Merge an MR |
| `gitlab_close_mr` | Close an MR without merging |
| `gitlab_list_pipelines` | List pipelines |
| `gitlab_trigger_pipeline` | Start a pipeline; `variables` is `[{key, value}]` |
| `gitlab_get_pipeline` | Poll one pipeline |
| `gitlab_retry_pipeline` | Retry failed jobs |
| `gitlab_cancel_pipeline` | Cancel a running pipeline |
| `gitlab_search_projects` | Project search |
| `gitlab_search_code` | Code search |
| `gitlab_search_issues` | Issue search |
| `gitlab_get_clone_url` | Mint a token-embedded clone URL |

## google-calendar

| Tool | Purpose |
|---|---|
| `google_calendar_list_events` | List events in a time range |
| `google_calendar_create_event` | Create an event |
| `google_calendar_get_event` | One event |
| `google_calendar_update_event` | Patch an event |
| `google_calendar_delete_event` | Delete an event |
| `google_calendar_list_calendars` | List the user's calendars |
| `google_calendar_freebusy` | Free/busy query across calendars |

## google-docs

| Tool | Purpose |
|---|---|
| `google_docs_get` | Full document structure |
| `google_docs_get_plaintext` | Document text only |
| `google_docs_create` | Create a document |
| `google_docs_batch_update` | Apply a batch of document edits |
| `google_docs_search` | Find documents via Drive |

## google-drive

| Tool | Purpose |
|---|---|
| `google_drive_list` | List files with a raw Drive `q` query |
| `google_drive_create_folder` | Create a folder |
| `google_drive_search` | Name and full-text search, query escaped |
| `google_drive_upload` | Upload file content |
| `google_drive_upload_from_url` | Fetch a URL into Drive |
| `google_drive_download` | Download file content |
| `google_drive_trash` | Move a file to trash |
| `google_drive_permissions` | Update sharing permissions for a file |

> [!NOTE] `google_drive_upload_from_url` blocks private addresses by hostname
> It requires https and rejects `localhost`, `127.*`, `10.*`, `172.16–31.*`,
> `192.168.*`, `169.254.*`, `0.0.0.0`, and IPv6 loopback/ULA/link-local. This is a
> string check on the hostname, so a public DNS name resolving to a private address is
> not caught.

## google-gemini

| Tool | Purpose |
|---|---|
| `google_gemini_generate` | Generate content with a Gemini model |

## google-gmail

| Tool | Purpose |
|---|---|
| `google_gmail_send` | Send a message, or reply inside a thread |
| `google_gmail_list` | List messages |
| `google_gmail_get` | One message, body decoded, with its `messageIdHeader` |
| `google_gmail_modify` | Change labels — mark read, archive |
| `google_gmail_profile` | The mailbox profile |
| `google_gmail_labels` | List labels |
| `google_gmail_threads` | List conversation threads |
| `google_gmail_draft` | Create a draft |

## google-sheets

| Tool | Purpose |
|---|---|
| `google_sheets_read` | Read a range |
| `google_sheets_write` | Overwrite a range |
| `google_sheets_append` | Append rows |
| `google_sheets_create` | Create a spreadsheet |
| `google_sheets_search` | Find spreadsheets |

## google-slides

| Tool | Purpose |
|---|---|
| `google_slides_get` | Read a presentation |
| `google_slides_create` | Create a presentation |
| `google_slides_batch_update` | Apply a batch of slide edits |
| `google_slides_search` | Find presentations |
| `google_slides_create_from_markdown` | Build slides from Markdown — `---` splits slides, `\|\|\|` makes two columns |

## httpbin-cookie

The reference cookie-auth plugin. It exists to exercise the browser-session capture
path end to end, and ships no logo on purpose so the portal's fallback icon gets used.

| Tool | Purpose |
|---|---|
| `httpbin_get_cookies` | Read back the cookies the proxy sent |
| `httpbin_set_cookie` | Set a cookie on httpbin |
| `httpbin_get_headers` | Echo request headers — verifies `Cookie` injection |

## newrelic

All thirteen go through NerdGraph. The endpoint is region-scoped from the connection's
stored `region`.

| Tool | Purpose |
|---|---|
| `newrelic_run_nrql` | Run an NRQL query |
| `newrelic_search_entities` | Entity search |
| `newrelic_get_dashboard` | Read a dashboard |
| `newrelic_create_alert_policy` | Create an alert policy |
| `newrelic_create_static_nrql_condition` | Add a static NRQL alert condition |
| `newrelic_create_alert_notification_channel` | Create a legacy notification channel |
| `newrelic_add_notification_channels_to_policy` | Attach legacy channels to a policy |
| `newrelic_create_ai_notifications_destination` | Create a notification destination |
| `newrelic_create_ai_notifications_channel` | Create a notification channel |
| `newrelic_create_ai_workflow` | Create a workflow linking a policy to channels |
| `newrelic_add_tags_to_entity` | Tag an entity |
| `newrelic_add_widgets_to_dashboard_page` | Add widgets to a dashboard page |
| `newrelic_configure_cloud_integration` | Configure a cloud integration |

The two legacy alert-channel mutations are best-effort and were never verified against
a live account.

## slack

Slack's scopes are **user** scopes, so these tools act as the connecting user, not as a
bot.

| Tool | Purpose |
|---|---|
| `slack_send_message` | Post a message to a channel |
| `slack_update_message` | Edit a message |
| `slack_delete_message` | Delete a message — destructive |
| `slack_list_channels` | List channels |
| `slack_get_channel_history` | Read channel history |
| `slack_upload_file` | Upload a file |
| `slack_add_reaction` | Add an emoji reaction |
| `slack_get_thread_replies` | Read a thread |
| `slack_lookup_user` | Look up a user by exact email |
| `slack_send_dm` | Send a direct message |
| `slack_search_all` | Search messages and files |
| `slack_list_users` | List workspace users |
| `slack_download_file` | Download a Slack-hosted file |
| `slack_get_file_info` | File metadata |
| `slack_remove_reaction` | Remove a reaction |
| `slack_get_permalink` | Permalink for a message |
| `slack_join_channel` | Join a public channel |
| `slack_find_users` | Fuzzy user search |

`slack_download_file` needs the `files:read` scope. It validates the host before
sending the credential and drops the Bearer the moment a redirect leaves Slack, so the
token cannot be redirected out.

## browser (internal)

Nine tools driving one warm, per-user Chromium session. Always connected — this is an
`auth: none` integration. Every action tool ensures the session exists and marks it
active, so an idle session is reaped but a working one is not.

| Tool | Purpose |
|---|---|
| `browser_navigate` | Navigate the session. `http`/`https` only |
| `browser_screenshot` | Downscaled JPEG of the viewport; returns `{ unchanged: true }` when pixels are identical to the last shot |
| `browser_click` | Click at coordinates — left, right, or middle |
| `browser_type` | Type into the focused element |
| `browser_key` | Press a key or chord |
| `browser_scroll` | Scroll a direction, 600px by default |
| `browser_read_text` | `document.body.innerText`, optionally truncated |
| `browser_close` | Close the session, keep the profile |
| `browser_live_url` | Mint a link that hands the live browser to a human |

`browser_screenshot` defaults to a maximum width of 1000 pixels and clamps quality to
1–100. `browser_live_url` returns a portal URL carrying a signed connect token, valid
for `CONNECT_TTL_SECONDS` (600 by default).

`browser_close` ends the warm session and keeps the profile. There is one Chromium per
user, shared with cookie capture rather than exclusive with it.

## jots (internal)

Five tools for hosting static files. Also `auth: none`.

| Tool | Purpose |
|---|---|
| `deploy_jot` | Returns `{ uploadUrl, token, expiresAt, maxBytes }` for a gzip-tarball upload that replaces the jot |
| `update_jot` | Same, in patch mode: the archive is overlaid onto the live jot, plus an optional `delete` list. `access` / `password` / `cors` are applied to the live jot immediately, no upload needed |
| `list_jot_files` | List a jot's files — path, bytes, updatedAt |
| `list_jots` | List the caller's own jots — never anyone else's |
| `delete_jot` | Delete a jot you own |

`deploy_jot` rejects an invalid name (`INVALID_NAME`), `access: "password"` without a
password (`PASSWORD_REQUIRED`), and a name already owned by another user
(`JOT_NAME_TAKEN` — names are global and creator-locked). Passwords are hashed before
the token is minted. `update_jot`, `list_jot_files`, and `delete_jot` return `FORBIDDEN`
for another owner's jot and `NOT_FOUND` when it does not exist. `update_jot` also
rejects a `delete` entry that escapes the jot or names the manifest (`INVALID_PATH`).

A patch upload inherits `access` and the password hash from the live jot, so the archive
cannot change gating, and it needs no root `index.html` — the live one is retained.

Gating is changed through `update_jot`'s own arguments instead. `access`
(`public` / `password`), `password`, and `cors` are written to the manifest when the tool
is called, not when an archive lands, and come back in the result as
`applied: { access, cors }`. `password` alone implies `access: "password"`; an empty
password is `PASSWORD_REQUIRED`, as is switching to `password` on a jot with no stored
hash; restating `access: "password"` without a new password keeps the current one; going
public drops the hash. Any change to the hash invalidates the unlock cookies already
issued for that jot. Omitted settings are inherited from the live manifest.

Both tools accept `cors: true`, which on a **public** jot serves its files with
`Access-Control-Allow-Origin: *` so the page can fetch its own data. The sandbox CSP is
unchanged. The flag is ignored on password jots. On `update_jot`, `cors: false` turns it
back off.

Limits come from configuration: `JOTS_MAX_BYTES` (5 MiB), `JOTS_MAX_FILES` (1000), and
`JOTS_UPLOAD_TTL_SECONDS` (300, single use). An archive with no root `index.html` is
rejected with `NO_INDEX`. A patch is re-measured after the merge, so one that pushes the
tree over either cap is rejected with `TOO_LARGE` / `TOO_MANY_FILES`.
