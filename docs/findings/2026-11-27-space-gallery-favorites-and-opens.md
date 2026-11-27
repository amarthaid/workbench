# Space gallery: favorites, opens and what to count

The Spaces page was a flat grid, the same for everybody. The change makes it
depend on the person (favorites first, then what they opened lately) and adds two
numbers: how many people favorited a Space, and, for the owner, how many people
used it. The traffic design went through an independent review before it was
built, and the review changed it in ways worth keeping.

## What the review changed

- **Count opens from the portal shell, not from the file route.** The first idea
  was to count each `index.html` served at `/s/:name/app/<sig>/`. That route only
  verifies the signature: it cannot tell an open from a reload (responses are
  `no-store`, so every reload re-serves the document, and so does every
  subdirectory `index.html`), it never re-checks access, consent or a disabled
  user, and a copied `sig` URL keeps working as that person for about 12 hours.
  The shell now posts `/api/spaces/:name/open` when it mounts the Space, which
  goes through the same `openable()` check as everything else and is recorded
  only for someone who approved the tool list.
- **The unit is people, not opens.** Raw opens are dominated by one heavy user or
  an author iterating. "People other than the owner who opened it in 30 days" is
  unaffected by reloads, prefetch or `sig` reuse. Opens are idempotent: one row
  per person and Space holding when they last opened it, so there is no debounce
  and no race to get wrong, and no daily table to prune.
- **One table.** `space_user_state(space_name, user_id, favorited_at,
  last_opened_at)` carries favorites, recency and the people count.
- **A count that points at individuals is not shown.** On a Space shared with
  three people, "2 opened it" says who. The owner sees the number for an
  everyone-signed-in Space, and for a shared one only from five people up.
- **Count only people who can still open it.** Rows are kept when someone loses
  access (re-sharing brings them back) but the count joins to the share list, by
  the lowercased email the shares are stored under. A private Space shows no
  favorite count at all.
- **Popularity stays out of the order.** It would put the Spaces open to everyone
  on top for everybody and keep them there.
- **A metadata edit is not an update.** `updated_at` drives "updated 2h ago" and
  the New mark, and `updateSpaceMeta` used to set it on every change, including a
  title edit or a sharing change. It now moves only when the tool list changes
  (uploads and deploys still set it). The compare-and-set on the row never
  depended on it.
- **Space names are reused after a delete**, so `deleteSpace` also deletes the
  per-person rows, or a new Space would inherit the old one's favorites.

## Left out on purpose

A "needs connection" chip on tiles: it costs a connection lookup per integration
per Space on every gallery load, and for a delegated Space it is the owner's
connections that matter, which a viewer should not see on a tile. Daily history
and trends, returning-viewer counts and a popularity sort are deferred until
someone asks for them.

## Known limit

A portal edit of the title or description is overwritten by the next
`deploy_space`, which replaces them by design. The edit dialog says so.
