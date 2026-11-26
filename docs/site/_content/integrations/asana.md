---
title: Asana
description: Connect Asana so an agent can create, read, update, complete, and comment on tasks across projects, including custom fields, sections, start dates and subtasks.
---

The Asana integration covers the task loop. It can find a project, list or create tasks in it, read one back by gid, update or complete it, and comment on it. Tasks come back with their custom fields, section and start date, and a task's dated subtasks (the delivery phases many teams track) are a call away. Everything is addressed by gid, so most workflows start with `asana_list_projects` or `asana_search_users`.

## At a glance

| | |
|---|---|
| Plugin id | `asana` |
| Auth | OAuth 2.0 |
| Tools | 10 |
| Authorization URL | `https://app.asana.com/-/oauth_authorize` |
| Token URL | `https://app.asana.com/-/oauth_token` |
| Proxy base | `https://app.asana.com/api/1.0` |

## Set up the OAuth app

> [!NOTE] The console steps are Asana's UI, not this server's
> Menu names, labels, and page URLs below come from Asana's console and change
> without notice. If what you see differs, follow [Asana's own documentation](https://developers.asana.com/docs) — the values this server needs (the callback URL and the scopes in the tables
> below) are unaffected.

:::steps
### Create the app

Open [app.asana.com/0/my-apps](https://app.asana.com/0/my-apps) → **Create new app**. Name it, accept the API terms, create.

### Add the redirect URL

App → **OAuth** tab → Redirect URLs:

```
https://<your-workbench-host>/api/auth/plugin/asana/callback
```

Asana permits `http` for localhost, so add `http://localhost:3000/api/auth/plugin/asana/callback` for development.

### Keep Full permissions

Leave the app on Full permissions, which is what the `default` scope maps to. Do not switch it to granular scopes unless you also change the manifest — see the gotcha below.

### Copy the credentials

Same OAuth tab: **Client ID**, and **Client secret** via reveal.

### Distribute, if others will connect

**Manage Distribution** → choose Limited or Public. New apps are private to the creator's account.
:::

## Scopes

| Scope | What it is for |
|---|---|
| `default` | Asana's full-permissions scope: the token can do anything the connecting user can do |

## Server configuration

```bash
ASANA_CLIENT_ID=...
ASANA_CLIENT_SECRET=...
```

## Connect

Portal: Connections → **Connect** on the Asana card.

Agent:

```
connect({ integration: "asana" })
wait_for_connection({ connectionId })
```

## Tools

| Tool | Purpose |
|---|---|
| `asana_list_projects` | Projects as `{ gid, name }` rows, optionally scoped to a workspace |
| `asana_list_tasks` | Tasks in a project as slim rows with completion, start and due date, assignee, section and custom fields; pages with `offset` |
| `asana_create_task` | Create a task in a project, optionally with start date, section and custom fields, and return its gid |
| `asana_get_task` | One task by gid, notes truncated to 2000 characters, with dates, sections, custom fields and permalink |
| `asana_update_task` | Update fields, start date, custom fields and section, and complete or reopen via `completed` |
| `asana_list_subtasks` | The subtasks of a task with their start and due dates and custom fields; pages with `offset` |
| `asana_list_sections` | The sections of a project, in board order |
| `asana_add_comment` | Add a plain-text comment (story) to a task |
| `asana_list_teams` | Teams in an organization as `{ gid, name }` rows |
| `asana_search_users` | Resolve users to gids for assignment |

## Custom fields, sections and dates

Reads return `custom_fields` as a plain `{ name: value }` map: enum values are the option name, multi-enum and people values are lists, dates are `YYYY-MM-DD`, numbers and text as they are. Fields that have no value on the task are left out, so a project with many unused fields stays compact. If a project has two fields with the same name, the later one is shown as `Name (2)`. `asana_list_tasks` shows each task's section within the listed project, and `asana_get_task` lists the section per project.

Writes take the same friendly form, so an agent never handles field or option gids:

```
asana_update_task({
  taskGid: "123",
  start_on: "2026-12-01",
  section: "In Delivery",
  customFields: { "Status": "In Progress", "Estimated Hours": 8, "Release Date": "2026-12-15" }
})
```

- **Names:** field names and option names match case-insensitively and ignore surrounding spaces. A field gid also works as the key, and is required when two fields on the task share a name.
- **Values:** enum takes one option name, multi-enum a list of names, dates `YYYY-MM-DD`, people a list of user gids. `null` clears a field, and `start_on: null` clears the start date.
- **Validation first:** names are resolved before anything is written. An unknown field, option or section stops the call with the valid names in the message, so a typo never leaves a task half-updated.
- **Sections:** `section` moves the task. When the task is in several projects, pass `projectId` to say which project's section. `asana_create_task` takes `section` too and places the new task after creating it.
- **Not settable:** field types other than enum, multi-enum, number, text, date and people are read-only here.

## Notes and gotchas

> [!WARNING] Granular-scope mode must match the manifest exactly
> The manifest requests the single scope `default`. Asana's app settings offer a full-permissions mode and a granular-scope mode, and `default` belongs to the full-permissions mode. Switching the app to granular scopes while the manifest still requests `default` fails the authorize call. The reverse fails too. If you need granular scopes, change the manifest to match. [Asana's OAuth documentation](https://developers.asana.com/docs) describes the two modes.

Completing a task is an update, not a separate call: `asana_update_task` with `completed: true`. Passing `false` reopens it.

List tools return 10 rows by default. Raise `limit` when you expect more, rather than assuming a short list is the whole project.

The server refreshes an expired access token automatically and keeps the existing refresh token when Asana returns none. Token lifetimes are Asana's to set — see [Asana's OAuth documentation](https://developers.asana.com/docs) for the current values.

A 402 response means the endpoint requires a paid Asana plan. Asana also rate-limits per token, and the ceiling depends on the plan. The current figures are in [Asana's API documentation](https://developers.asana.com/docs).
