/**
 * Ranked tool search for `search_tools`.
 *
 * The old search was `name.includes(query) || description.includes(query)`
 * over the whole query string: "create jira issue" matched nothing (no
 * description holds that exact phrase), a typo matched nothing, and a hit
 * came back in registry order with no limit. Agents type phrases, so this
 * scores per word instead:
 *
 *  - tokenise both sides (snake_case, camelCase, punctuation), drop stop
 *    words, fold plurals and -ing/-ed;
 *  - each query word matches a tool word exactly, by prefix ("calend"), by a
 *    synonym ("ticket" → issue), or within a small edit distance ("emial");
 *  - a match in the tool name counts more than one in the integration, and
 *    both more than one in the description, which is BM25-weighted (rare
 *    words count more, long descriptions count each word less);
 *  - a tool that matches every query word outranks one that matches a few.
 *
 * No index, no dependency: a few hundred tools score in well under a
 * millisecond, and the per-tool token lists are memoised.
 */

export interface Searchable {
  name: string;
  description: string;
  integration: string;
}

export interface Ranked<T> {
  tool: T;
  score: number;
}

const STOP = new Set([
  "a", "an", "the", "to", "for", "of", "in", "on", "at", "by", "with", "from", "into",
  "and", "or", "is", "are", "be", "it", "its", "this", "that", "my", "me", "i", "you",
  "your", "some", "any", "via", "using", "use", "as", "can", "how", "do", "does",
]);

/** Words agents use interchangeably; every word maps to the rest of its group. */
const SYNONYM_GROUPS = [
  ["email", "mail", "gmail", "inbox"],
  ["issue", "ticket", "bug"],
  ["task", "todo"],
  ["message", "msg", "dm", "chat"],
  ["send", "post"],
  ["pr", "pull"],
  ["mr", "merge"],
  ["repo", "repository"],
  ["doc", "document"],
  ["sheet", "spreadsheet"],
  ["delete", "remove", "trash"],
  ["create", "add", "new", "make", "open"],
  ["search", "find", "query", "lookup"],
  ["list", "show", "browse"],
  ["update", "edit", "modify", "change"],
  ["event", "meeting", "calendar"],
  ["user", "member", "person", "people"],
  ["folder", "directory", "dir"],
  ["pipeline", "ci", "build", "workflow"],
  ["page", "wiki"],
  ["upload", "attach", "attachment"],
  ["comment", "reply"],
  ["status", "transition", "state"],
  ["secret", "vault", "credential", "password"],
  ["save", "store", "write"],
  ["site", "jot", "deploy", "publish"],
];

const SYNONYMS = new Map<string, string[]>();
for (const raw of SYNONYM_GROUPS) {
  const group = raw.map(stem);
  for (const w of group) SYNONYMS.set(w, group.filter((x) => x !== w));
}

/**
 * Crude suffix folding, applied to both query and tool words so they meet in
 * the middle: "updates", "updated", "updating" and "update" all become
 * "updat". Not English, just consistent.
 */
export function stem(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0, -3) + "y";
  else if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 4 && /(s|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (w.length > 2 && w.endsWith("s") && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1); // prs → pr
  if (w.length > 4 && w.endsWith("e")) w = w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    // tool names say pr/mr, prose says the phrase
    .replace(/pull[\s_-]*requests?/g, " pr ")
    .replace(/merge[\s_-]*requests?/g, " mr ")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w))
    .map(stem);
}

/** Optimal-string-alignment distance (a transposition costs 1), bailing out above `max`. */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows: number[][] = [];
  for (let i = 0; i <= a.length; i++) rows.push([i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d = Math.min(d, rows[i - 2][j - 2] + 1);
      }
      rows[i][j] = d;
      rowMin = Math.min(rowMin, d);
    }
    if (rowMin > max) return max + 1;
  }
  return rows[a.length][b.length];
}

const EXACT = 1;
const SYNONYM = 0.8;
const PREFIX = 0.7;
const FUZZY = 0.6;

/** How well query word `q` matches tool word `w`, 0 for no match. */
function wordMatch(q: string, w: string): number {
  if (q === w) return EXACT;
  if (SYNONYMS.get(q)?.includes(w)) return SYNONYM;
  if (q.length >= 3 && w.startsWith(q)) return PREFIX;
  const max = q.length >= 8 ? 2 : q.length >= 4 ? 1 : 0;
  if (max > 0 && editDistance(q, w, max) <= max) return FUZZY;
  return 0;
}

interface Fields {
  name: string[];
  integration: string[];
  description: string[];
}

const fieldCache = new WeakMap<object, Fields>();

function fieldsOf(t: Searchable): Fields {
  let f = fieldCache.get(t);
  if (!f) {
    f = {
      name: tokenize(t.name),
      integration: tokenize(t.integration),
      description: tokenize(t.description),
    };
    fieldCache.set(t, f);
  }
  return f;
}

const NAME_WEIGHT = 3;
const INTEGRATION_WEIGHT = 2;
const DESCRIPTION_WEIGHT = 1;
const K1 = 1.2;
const B = 0.75;

/** Best match quality of `q` in a field and how many words hit it. */
function fieldMatch(q: string, words: string[], memo: Map<string, number>): { quality: number; count: number } {
  let quality = 0;
  let count = 0;
  for (const w of words) {
    let m = memo.get(w);
    if (m === undefined) {
      m = wordMatch(q, w);
      memo.set(w, m);
    }
    if (m > 0) {
      count++;
      if (m > quality) quality = m;
    }
  }
  return { quality, count };
}

/**
 * Score `tools` against `query`, best first. Tools that match no query word
 * are dropped. `limit` caps the result; omit it for every match.
 */
export function rankTools<T extends Searchable>(tools: T[], query: string, limit?: number): Ranked<T>[] {
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0 || tools.length === 0) return [];

  const docs = tools.map(fieldsOf);
  const avgLen = docs.reduce((n, d) => n + d.description.length, 0) / docs.length || 1;
  const normalizedQuery = query.trim().toLowerCase();

  // per term: per-doc weighted match, then IDF over the docs it hit
  const scores = new Array<number>(tools.length).fill(0);
  const matched = new Array<number>(tools.length).fill(0);
  const inName = new Array<number>(tools.length).fill(0);

  for (const q of terms) {
    const memo = new Map<string, number>();
    const perDoc: number[] = [];
    let df = 0;
    docs.forEach((d, i) => {
      const n = fieldMatch(q, d.name, memo);
      if (n.quality > 0) inName[i]++;
      const g = fieldMatch(q, d.integration, memo);
      const s = fieldMatch(q, d.description, memo);
      const tf = s.count;
      const desc = tf > 0 ? (s.quality * (tf * (K1 + 1))) / (tf + K1 * (1 - B + (B * d.description.length) / avgLen)) : 0;
      const v = NAME_WEIGHT * n.quality + INTEGRATION_WEIGHT * g.quality + DESCRIPTION_WEIGHT * desc;
      perDoc[i] = v;
      if (v > 0) df++;
    });
    if (df === 0) continue;
    const idf = Math.log(1 + (tools.length - df + 0.5) / (df + 0.5));
    perDoc.forEach((v, i) => {
      if (v > 0) {
        scores[i] += idf * v;
        matched[i]++;
      }
    });
  }

  const ranked: Ranked<T>[] = [];
  tools.forEach((tool, i) => {
    if (matched[i] === 0) return;
    // Matching every word beats matching a few strongly; matching them in the
    // name ("create jira issue" → jira_create_issue) beats the description.
    const coverage = matched[i] / terms.length;
    const nameCoverage = inName[i] / terms.length;
    // A name with fewer unmatched words is the more specific hit:
    // "list pull requests" → github_list_prs over github_list_pr_comments.
    const name = docs[i].name;
    const namePrecision = name.length ? name.filter((w) => terms.some((q) => wordMatch(q, w) > 0)).length / name.length : 0;
    let score =
      scores[i] * (0.25 + 0.75 * coverage * coverage) * (1 + nameCoverage * nameCoverage) * (0.8 + 0.2 * namePrecision);
    if (tool.name.toLowerCase() === normalizedQuery) score *= 2;
    ranked.push({ tool, score: Math.round(score * 100) / 100 });
  });

  ranked.sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name));
  return limit === undefined ? ranked : ranked.slice(0, limit);
}
