# search_tools matched one literal string, so agent phrasing found nothing

**Symptom.** `search_tools` returned `[]` for `"create jira issue"` and for
`"send emial"`, while `"jira"` returned 16 tools in registry order: every Jira
tool, plus a `vision_*` and a `newrelic_*` tool whose descriptions happen to
mention Jira, with nothing to say which fitted. Agents describe a task in
words, so the common case was a miss followed by a retry with one keyword.

**Cause.** Both the registry and the custom-app index kept a tool when
`name.includes(query) || description.includes(query)` over the whole
lowercased query. A multi-word query only hit a description that held that
exact phrase. There was no tokenising, typo tolerance, synonyms, ranking
or limit.

**Fix.** `packages/server/src/plugins/search.ts` scores per word, with no
index and no dependency:

- Tokenise the query and each tool's name, integration and description:
  snake_case, camelCase and punctuation split, stop words dropped, a crude
  stem applied to both sides (`updates`/`updated`/`update` → `updat`,
  `prs` → `pr`), and `pull request` / `merge request` folded to `pr` / `mr`,
  since tool names use the short form and descriptions the phrase.
- A query word matches a tool word exactly (1.0), by synonym (0.8), by prefix
  of 3+ letters (0.7), or within edit distance 1 (4+ letters) or 2 (8+)
  (0.6). The distance is optimal-string-alignment, so `emial` → `email` is one edit.
- Field weights are name 3, integration 2 and description 1. The description
  term is BM25-saturated and length-normalised. Each word is IDF-weighted
  over the corpus it is searched in.
- Multipliers: coverage² (a tool matching every word beats one that matches a
  few strongly), name coverage² (the words appear in the name), name
  precision (fewer unmatched name words wins, so `github_list_prs` beats
  `github_list_pr_comments`), and ×2 for an exact tool name.

`search_tools` ranks built-in and custom-app tools as one corpus, returns the
top 10 by default (`limit` up to 50), and adds a `score` to each row.
Otherwise the output shape is unchanged.

**Measured on the 226-tool built-in catalog.** Twelve agent phrasings now put
the intended tool first; they are pinned in `tests/tool-search.test.ts`.
The old substring search found 2 of the 12, where the query was a literal
tool name or a phrase in a description (`browser_navigate`,
`search confluence pages`). The other 10 returned `[]`. A query takes about 1–3 ms,
and the first one takes about 15 ms while it fills the per-tool token cache
(a `WeakMap`, so custom-app tools drop out with their index).

**Against Composio.** Composio's `SEARCH_TOOLS` is semantic and returns a plan
plus full schemas. It found `GMAIL_SEND_EMAIL` for `"send emial"`, but one
answer was about 5k tokens and included connected-account details. The
approach here keeps workbench's thin rows and gets most of the recall for
free. Embedding search would need a model or an API key, which self-hosting
should not require.

**Limits.** Synonyms are a fixed list. A concept with no word in common with
the tool and no synonym entry still misses; `"notes"` finds nothing useful.
Scores rank one result list and are not comparable across queries.
