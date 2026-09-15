# Workspace uploads inherited the OAuth form parser and committed 0-byte files

**Date:** 2026-09-15
**Area:** `packages/server/src/workspace/routes.ts`, `packages/server/src/api/oauth-routes.ts`

## Symptom

```bash
printf 'hello\n' | curl -X POST -H "x-workbench-api-key: $K" \
  -H 'content-type: application/x-www-form-urlencoded' --data-binary @- \
  localhost:3000/api/files/x.txt
# → 201 {"name":"x.txt","bytes":0,...}
```

Same for a presigned `PUT /api/files/ul/<token>`. The file was created, the
upload token was spent, the response said success, and the file was empty.
`curl --data-binary` sends `application/x-www-form-urlencoded` when no
`content-type` is given, so this was the *default* shape of a scripted upload.
`application/octet-stream`, `text/plain`, and a missing header all worked.

## Cause

The workspace scope removed the two built-in parsers (`application/json`,
`text/plain`) and registered a `*` catch-all that hands the raw stream to the
route — the ordering trap from
[2026-09-11](2026-09-11-rest-tool-execution-endpoint.md): an exact-match parser
beats any catch-all.

But a child scope inherits *every* parser on the app at registration time, not
just the built-ins. `registerOAuthRoutes` runs first in `app.ts` and adds an
exact-match `application/x-www-form-urlencoded` parser that turns the body into
an object. Inside the workspace scope that parser still won, `request.body`
arrived as `{}`-ish instead of a stream, the route piped nothing, and
`handle.commit()` wrote what it had: nothing. `registerJotRoutes` adds
`application/gzip` the same way; it happens to hand over the raw stream, so gzip
uploads worked by luck.

## Fix

`scope.removeAllContentTypeParsers()` before the catch-all, instead of naming
the two built-ins. A scope that wants raw bytes for every type should not be
enumerating which parsers it thinks exist on the parent — that list is a claim
about boot order elsewhere in the tree, and it silently went stale.

Removal is scoped: `/token` still parses form bodies (verified live,
`invalid_grant` not a parser error).

## Regression test

`tests/workspace-routes.test.ts` — "stores a form-urlencoded upload
byte-for-byte when an app-level parser owns that type". The existing harness
registered the workspace routes on a bare Fastify instance, so it could never
see this: the test builds the app the way `app.ts` does, app-level form parser
first, then the workspace scope.

## Lesson

When a scope calls `removeContentTypeParser([...])` to make room for a
catch-all, it is encoding an assumption about every earlier `register` call. Use
`removeAllContentTypeParsers()` for a raw-body scope, and test it on an app that
has the parsers the real boot adds.
