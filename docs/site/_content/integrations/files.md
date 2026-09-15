---
title: Files
description: A per-user file workspace — browser downloads land here, uploads are read from here, and files move between integrations without passing through the model.
---

`files` is where an agent keeps bytes.

Before it existed, bytes could only move between integrations by travelling through the model's context as text. That made binary impossible and made a 5&nbsp;MB CSV cost a 5&nbsp;MB prompt. A browser download had nowhere to land at all — it went to the browser process's own temp directory, which no tool could read.

Like `browser` and `jots`, it is an internal plugin: server source rather than `PLUGINS_DIR`, `auth: { type: "none" }`, always connected, no setup.

## Retention: read this part first

> **A file is deleted 24 hours after it is written, whether or not anything is using it. Reading a file does not extend its life.**

There is no grace period, no "in use" check and no exception. This is a transfer buffer, not a document store.

That sounds severe, and it is the deliberate trade that makes everything else simple: with age as the only rule, the sweep needs no coordination, no shared liveness state and no secrets, so it can run as one scheduled job against a shared volume instead of a timer inside every server process.

What it means in practice: **an agent that needs a file to outlive the window must hand it somewhere durable in the same run** — a Drive upload, a Slack upload, a Sheet.

## At a glance

| | |
|---|---|
| Plugin id | `files` |
| Auth | None (internal, always connected) |
| Tools | 6 |
| Retention | `WORKSPACE_TTL_HOURS`, default 24 |
| Per-file cap | `WORKSPACE_MAX_FILE_BYTES`, default 100&nbsp;MB |
| Per-user quota | `WORKSPACE_MAX_BYTES_PER_USER`, default 256&nbsp;MB |

## Tools

| Tool | Purpose |
|---|---|
| `files_list` | Your files — name, bytes, mtime, expiry — plus usage against quota |
| `files_stat` | One file's size and expiry without reading it |
| `files_read` | Read a file, `utf8` or `base64` |
| `files_write` | Write a file into the workspace |
| `files_presign` | Mint a short-lived URL to fetch or write one file |
| `files_delete` | Delete a file early to reclaim quota |

Every tool is scoped to the caller by the credential, never by anything in the request. Another user's file reads as `NOT_FOUND`, not `FORBIDDEN` — the difference matters, because `FORBIDDEN` would confirm the file exists.

## Three ways in and out

**MCP tools.** `files_read` and `files_write` put the bytes through the agent's context. Convenient for small text, wasteful for anything else, and `files_read` refuses rather than truncating when a file is over the cap — a CSV cut off mid-row still parses, which makes a silent truncation worse than an error.

**REST, with the same credential as `/mcp`.**

```
GET    /api/files            list
GET    /api/files/:name      stream a file out
POST   /api/files/:name      stream a file in (raw body)
DELETE /api/files/:name      delete
```

**Presigned URLs**, for anything that cannot hold a workbench credential — a service that ingests by URL, an upload target, a transfer that should not pass through the agent at all.

```
files_presign({ name, op: "download" })  ->  GET  /api/files/dl/<token>
files_presign({ name, op: "upload" })    ->  PUT  /api/files/ul/<token>
```

Download tokens can be spent repeatedly inside their five minutes, because fetches get retried and some clients `HEAD` before `GET`. Upload tokens are spent exactly once. The filename lives in the token's own record and is never read off the request — an upload URL that honoured a caller-supplied name would be a write-anywhere primitive.

The token is in the URL, so it reaches access logs. That is what the short lifetime is for; nothing here should be given a long one.

## Everything is served as an attachment

Every response from these routes is `application/octet-stream` with `Content-Disposition: attachment`, whatever the file actually is, plus `nosniff` and a `sandbox` CSP.

This is not caution for its own sake. The portal is served from the same origin as the API and keeps its bearer token client-side, so a file rendered *inline* from this origin runs with access to that credential — an uploaded `.html` would be stored XSS against the person who uploaded it.

## Working with the browser

The pairing this was built for:

```
browser_expect_download()   arm the wait
browser_click(...)          click the download button
browser_await_download()    -> { name, bytes, expiresAt }
files_read(name)            or files_presign, or hand it to another tool
```

Downloads land in the workspace **whether or not a wait was armed**, because routing is configured when the browser session starts. If an agent forgets to arm, the file is still in `files_list`.

Going the other way, `browser_upload_file({ selector, name })` puts a workspace file into an `<input type="file">`. `name` is a workspace-relative filename, never a path: it is resolved server-side against the caller's own directory, and the resolution follows symlinks before accepting anything. Chromium will upload whatever path it is handed to whatever form is on the page, so that resolution is the only thing standing between a tool argument and arbitrary file exfiltration.

## Isolation

Each user's files live in their own directory, named by a hash of the user id rather than a sanitized version of it. Sanitizing is lossy — two ids differing only in the sanitized characters would share a directory — and for files that would mean one user reading another's.

Tools and routes accept a **relative name only**, resolved against the caller's directory and checked twice: once on the input, once on the resolved result. Reads resolve symlinks and check again, because path arithmetic alone will happily accept a link pointing anywhere.

The model is an allowlist throughout. There is no list of forbidden patterns, and adding one would be a step backwards: a denylist is a claim that every way out has been enumerated.

## Cleaning up

Sweeping is a scheduled job, not a timer in the server:

```bash
npm run reap -w @a-workbench/server -- --files
```

See [Deploying](../deploy/docker.md) for how to schedule it and why it must not run in more than one place.
