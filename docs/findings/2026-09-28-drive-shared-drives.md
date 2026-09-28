# Google Drive tools could not see Shared Drives

**Symptom.** `google_drive_list` with a Shared Drive folder in `query`
(`'<folderId>' in parents`) returned `{ files: [] }` with no error, and
`google_drive_upload` with that folder as `parentId` returned
`404 File not found`. The connected account had access: a raw
`GET /drive/v3/files/<folderId>?supportsAllDrives=true` returned the folder.

**Cause.** Drive v3 treats Shared Drive items as invisible unless each call
opts in:

- `supportsAllDrives=true` — every call that reads or writes a Shared Drive
  item (`files.get`, `files.create`, `files.update`, `permissions.create`,
  …). Without it, a Shared Drive id is reported as nonexistent (404), not
  forbidden.
- `includeItemsFromAllDrives=true` — `files.list` only. Without it, Shared
  Drive rows are filtered out of the result silently, even when the `q`
  expression names a Shared Drive folder.

No new OAuth scope and no reconnect is needed.

**Fix.** Every call in `packages/plugins/google-drive/tools/drive.ts` sends
`supportsAllDrives=true` (list, search, create folder, upload, upload from
URL, download, trash, permissions), and list/search also send
`includeItemsFromAllDrives=true`. Covered in
`packages/server/tests/google-drive-query.test.ts`.

**Not yet covered.** The Docs, Slides and Sheets plugins search via
`files.list` without these flags, so their search tools still miss files
stored in Shared Drives.
