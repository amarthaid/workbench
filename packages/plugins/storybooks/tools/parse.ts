export interface IndexEntry {
  id: string;
  title: string;
  name: string;
  importPath?: string;
  type: string;
  tags: string[];
  componentPath?: string;
}

export interface ExtractedSection {
  id: string;
  title: string;
  content: string;
}

export interface ArgTypeConfig {
  name: string;
  control?: string;
  options?: string[];
  description?: string;
  typeSummary?: string;
}

export interface DesignToken {
  name: string;
  value: string;
  category: string;
}

export function decodeJsString(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
}

export function extractPlainText(source: string): string {
  const parts: string[] = [];
  for (const match of source.matchAll(/children:"((?:[^"\\]|\\.)*)"/g)) {
    const text = decodeJsString(match[1] ?? "").trim();
    if (text.length >= 2 && !text.startsWith("./") && !text.includes("jsx")) parts.push(text);
  }
  for (const match of source.matchAll(/children:`([^`]*)`/g)) {
    const text = (match[1] ?? "").trim();
    if (text.length >= 8) parts.push(text);
  }
  return [...new Set(parts)].join("\n\n");
}

export function extractSections(source: string): ExtractedSection[] {
  const sections: ExtractedSection[] = [];
  for (const match of source.matchAll(/(?:n\.)?h2,\{id:"([^"]+)",children:"([^"]+)"\}/g)) {
    const id = match[1];
    const title = match[2];
    if (id && title) sections.push({ id, title, content: "" });
  }
  const fullText = extractPlainText(source);
  if (sections.length === 0) {
    return fullText ? [{ id: "content", title: "Content", content: fullText }] : [];
  }
  for (const section of sections) {
    const idx = fullText.indexOf(section.title);
    section.content = idx >= 0 ? fullText.slice(idx, idx + 4000) : section.title;
  }
  return sections;
}

export function extractArgTypes(source: string): ArgTypeConfig[] {
  const blockMatch = source.match(/argTypes:\{([\s\S]*?)\}\},[\w$]+=\{args:/);
  const block = blockMatch?.[1] ?? source.match(/argTypes:\{([\s\S]*?)\}\}/)?.[1];
  if (!block) return [];
  const argTypes: ArgTypeConfig[] = [];
  for (const entry of block.split(/,(?=[a-zA-Z_$][\w$]*:\{)/)) {
    const name = entry.match(/^([a-zA-Z_$][\w$]*):\{/)?.[1];
    if (!name || name === "table" || name === "mapping") continue;
    const options = [...entry.matchAll(/options:\[(.*?)\]/g)]
      .flatMap((m) => [...(m[1]?.matchAll(/"([^"]+)"/g) ?? [])].map((x) => x[1]))
      .filter((v): v is string => Boolean(v));
    argTypes.push({
      name,
      control: entry.match(/control:"([^"]+)"/)?.[1],
      options: options.length ? [...new Set(options)] : undefined,
      description: entry.match(/description:"([^"]+)"/)?.[1],
      typeSummary: entry.match(/type:\{summary:"([^"]+)"/)?.[1],
    });
  }
  return argTypes;
}

export function extractPresets(source: string): Array<Record<string, unknown>> {
  const presets: Array<Record<string, unknown>> = [];
  for (const match of source.matchAll(/[\w$]=\{args:\{([\s\S]*?)\}\}/g)) {
    const argsBlock = match[1];
    if (!argsBlock) continue;
    const args: Record<string, unknown> = {};
    for (const stringVal of argsBlock.matchAll(/([a-zA-Z_$][\w$]*):\s*"([^"]*)"/g)) {
      if (stringVal[1]) args[stringVal[1]] = stringVal[2];
    }
    for (const boolVal of argsBlock.matchAll(/([a-zA-Z_$][\w$]*):\s*(true|false)/g)) {
      if (boolVal[1] && !(boolVal[1] in args)) args[boolVal[1]] = boolVal[2] === "true";
    }
    for (const numVal of argsBlock.matchAll(/([a-zA-Z_$][\w$]*):\s*(-?\d+(?:\.\d+)?)/g)) {
      if (numVal[1] && !(numVal[1] in args)) args[numVal[1]] = Number(numVal[2]);
    }
    if (Object.keys(args).length) presets.push(args);
  }
  return presets;
}

const TOKEN_RULES: Array<[string, RegExp]> = [
  ["colors", /^(--)?(colou?r|bg|background|fg|foreground|text|border|fill|stroke|primary|secondary|success|danger|warning|error|info)-/i],
  ["spacing", /^(--)?(spacing|space|gap|padding|margin|inset|size)-/i],
  ["typography", /^(--)?(font|text|typography|line-height|letter-spacing|leading|tracking)/i],
  ["shadows", /^(--)?(shadow|elevation)/i],
  ["radius", /^(--)?(radius|rounded|border-radius)/i],
  ["breakpoints", /^(--)?(breakpoint|screen|viewport|bp-)/i],
  ["motion", /^(--)?(duration|easing|transition|animation|motion)/i],
  ["z-index", /^(--)?(z-index|z-|layer)/i],
];

export function extractCssVariables(css: string): DesignToken[] {
  const tokens = new Map<string, DesignToken>();
  for (const match of css.matchAll(/(--[a-zA-Z0-9_-]+)\s*:\s*([^;}]+)[;}]/g)) {
    const name = match[1];
    const value = (match[2] ?? "").trim();
    if (!name || !value || value.length > 500 || tokens.has(name)) continue;
    const named = TOKEN_RULES.find(([, re]) => re.test(name));
    let category = named?.[0];
    if (!category) {
      if (/^#|^rgba?\(|^hsla?\(|^oklch\(|^oklab\(/i.test(value)) category = "colors";
      else if (/^-?\d+(\.\d+)?(px|rem|em|vh|vw|%)$/.test(value)) category = "spacing";
      else category = "other";
    }
    tokens.set(name, { name, value, category });
  }
  return [...tokens.values()];
}

export function renderJsx(name: string, args: Record<string, unknown>): string {
  const attrs = Object.entries(args).map(([key, value]) => {
    if (typeof value === "string") return `${key}=${JSON.stringify(value)}`;
    if (typeof value === "boolean") return value ? key : `${key}={false}`;
    return `${key}={${JSON.stringify(value)}}`;
  });
  return attrs.length ? `<${name} ${attrs.join(" ")} />` : `<${name} />`;
}

function escapeArg(value: string): string {
  return value.replace(/[;:"]/g, (c) => `\\${c}`);
}

function serializeArg(value: unknown): string {
  if (value === null) return "!null";
  if (value === undefined) return "!undefined";
  if (typeof value === "boolean") return value ? "!true" : "!false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function encodeStoryArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([key, value]) => `${escapeArg(key)}:${escapeArg(serializeArg(value))}`)
    .join(";");
}

export function stylesheetPath(href: string): string | undefined {
  const raw = href.trim();
  if (/^https?:/i.test(raw) || raw.startsWith("//")) return undefined;
  const path = raw.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!path || path.includes("..") || path.includes("\\") || !/\.css(?:$|\?)/i.test(path)) return undefined;
  return path;
}

export function componentName(title: string): string {
  return title.split("/").pop() || title;
}

export function matchingTitles(entries: IndexEntry[], component: string): string[] {
  const q = component.trim().toLowerCase().replace(/^\/+/, "");
  const titles = [...new Set(entries.map((e) => e.title))];
  const exact = titles.filter((t) => t.toLowerCase() === q);
  if (exact.length) return exact;
  return titles.filter((t) => {
    const last = (t.split("/").pop() ?? t).toLowerCase();
    return last === q || t.toLowerCase().endsWith(`/${q}`);
  });
}

export function resolveTitle(entries: IndexEntry[], component: string): string {
  const hits = matchingTitles(entries, component);
  if (hits.length === 0) throw new Error(`Component not found: ${component}`);
  if (hits.length > 1) {
    throw new Error(`Component "${component}" matches more than one title: ${hits.join(", ")}. Pass the full title.`);
  }
  return hits[0]!;
}

export interface FigmaMapping {
  figmaName?: string;
  figmaNodeId?: string;
  figmaUrl?: string;
  storybookComponent: string;
  storyId?: string;
  props?: Record<string, unknown>;
}

export type FigmaConfidence = "exact" | "high" | "medium" | "low";

export interface FigmaMatch {
  confidence: FigmaConfidence;
  storybookComponent: string;
  name: string;
  storyId?: string;
  suggestedProps: Record<string, unknown>;
  importPath?: string;
  source: "mapping" | "name";
}

interface StoryRow {
  title: string;
  name: string;
  variant: string;
  storyId: string;
  importPath?: string;
  type: string;
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeFigmaNodeId(raw: string): string {
  let value = raw.trim();
  try {
    value = decodeURIComponent(value);
  } catch {
    // Keep the raw node id when it is not percent-encoded.
  }
  if (/^\d+(?:[-:]\d+)+$/.test(value)) return value.replace(/-/g, ":");
  return value;
}

export function parseFigmaMappings(raw: string): FigmaMapping[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("figmaMappings is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("figmaMappings must be a JSON array");
  if (parsed.length > 500) throw new Error("figmaMappings accepts at most 500 rows");
  return parsed.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new Error(`figmaMappings[${index}] must be an object`);
    }
    const record = row as Record<string, unknown>;
    const storybookComponent = optionalString(record.storybookComponent);
    if (!storybookComponent) throw new Error(`figmaMappings[${index}] needs storybookComponent`);
    const figmaName = optionalString(record.figmaName);
    const figmaNodeId = optionalString(record.figmaNodeId);
    const figmaUrl = optionalString(record.figmaUrl);
    if (!figmaName && !figmaNodeId && !figmaUrl) {
      throw new Error(`figmaMappings[${index}] needs figmaName, figmaNodeId, or figmaUrl`);
    }
    const props =
      record.props && typeof record.props === "object" && !Array.isArray(record.props)
        ? (record.props as Record<string, unknown>)
        : undefined;
    return {
      figmaName,
      figmaNodeId: figmaNodeId ? normalizeFigmaNodeId(figmaNodeId) : undefined,
      figmaUrl,
      storybookComponent,
      storyId: optionalString(record.storyId),
      props,
    };
  });
}

export function figmaLookup(input: { figmaName?: string; figmaNodeId?: string; figmaUrl?: string }): {
  name?: string;
  nodeId?: string;
} {
  let name = input.figmaName?.trim() || undefined;
  let nodeId = input.figmaNodeId ? normalizeFigmaNodeId(input.figmaNodeId) : undefined;
  if (input.figmaUrl) {
    let url: URL;
    try {
      url = new URL(input.figmaUrl);
    } catch {
      throw new Error("figmaUrl is not a valid URL");
    }
    const fromQuery = url.searchParams.get("node-id");
    if (fromQuery && !nodeId) nodeId = normalizeFigmaNodeId(fromQuery);
    const nodeName = url.searchParams.get("node-name");
    if (!name && nodeName) name = decodeURIComponent(nodeName.replace(/\+/g, " "));
  }
  if (!name && !nodeId) {
    throw new Error("Pass figmaName, figmaNodeId, or a figmaUrl with node-id or node-name");
  }
  return { name, nodeId };
}

function storyRows(entries: IndexEntry[]): StoryRow[] {
  return entries.map((entry) => ({
    title: entry.title,
    name: componentName(entry.title),
    variant: entry.name,
    storyId: entry.id,
    importPath: entry.importPath,
    type: entry.type,
  }));
}

function sameComponent(row: StoryRow, component: string): boolean {
  const q = component.trim().toLowerCase();
  return row.title.toLowerCase() === q || row.name.toLowerCase() === q || row.title.toLowerCase().endsWith(`/${q}`);
}

function preferredRow(rows: StoryRow[], variantParts: string[], storyId?: string): StoryRow | undefined {
  if (storyId) return rows.find((row) => row.storyId === storyId) ?? rows[0];
  const stories = rows.filter((row) => row.type !== "docs");
  const pool = stories.length ? stories : rows;
  if (!variantParts.length) return pool[0];
  const parts = variantParts.map((part) => part.toLowerCase());
  let best = pool[0];
  let bestScore = -1;
  for (const row of pool) {
    const variant = row.variant.toLowerCase();
    const score = parts.reduce((sum, part) => sum + (variant.includes(part) ? 1 : 0), 0);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best;
}

function inferProps(variantParts: string[]): Record<string, unknown> {
  const props: Record<string, unknown> = {};
  for (const part of variantParts) {
    const lower = part.toLowerCase();
    if (/^(xs|sm|md|lg|xl|small|medium|large)$/.test(lower)) props.size = lower;
    else if (/(primary|secondary|tertiary|ghost|outline|solid|destructive|danger|success)/.test(lower)) {
      props.variant = lower.replace(/\s+/g, "-");
    } else if (/(default|disabled|hover|active|focus|loading)/.test(lower)) props.state = lower;
    else props[`variant_${Object.keys(props).length + 1}`] = part;
  }
  return props;
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  const rows = Array.from({ length: shorter.length + 1 }, () => 0);
  for (let j = 0; j <= shorter.length; j++) rows[j] = j;
  for (let i = 1; i <= longer.length; i++) {
    let previous = i - 1;
    rows[0] = i;
    for (let j = 1; j <= shorter.length; j++) {
      const current = rows[j]!;
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      rows[j] = Math.min(rows[j]! + 1, rows[j - 1]! + 1, previous + cost);
      previous = current;
    }
  }
  return (longer.length - rows[shorter.length]!) / longer.length;
}

function splitFigmaName(figmaName: string): { componentName: string; variantParts: string[] } {
  const parts = figmaName.split(/\s*\/\s*/).map((part) => part.trim()).filter(Boolean);
  return { componentName: parts[0] ?? figmaName, variantParts: parts.slice(1) };
}

function mappingNodeId(mapping: FigmaMapping): string | undefined {
  if (mapping.figmaNodeId) return mapping.figmaNodeId;
  if (!mapping.figmaUrl) return undefined;
  try {
    const id = new URL(mapping.figmaUrl).searchParams.get("node-id");
    return id ? normalizeFigmaNodeId(id) : undefined;
  } catch {
    return undefined;
  }
}

export function mapFigmaComponent(
  entries: IndexEntry[],
  lookup: { name?: string; nodeId?: string },
  mappings: FigmaMapping[],
): { match: FigmaMatch | null; alternatives: Array<{ storybookComponent: string; confidence: FigmaConfidence; reason: string }> } {
  const rows = storyRows(entries);
  const byNode = lookup.nodeId
    ? mappings.find((mapping) => mappingNodeId(mapping) === lookup.nodeId)
    : undefined;
  const byName = lookup.name
    ? mappings.find((mapping) => mapping.figmaName?.toLowerCase() === lookup.name?.toLowerCase())
    : undefined;
  const explicit = byNode ?? byName;

  if (explicit) {
    const matched = rows.filter((row) => sameComponent(row, explicit.storybookComponent));
    const { variantParts } = splitFigmaName(lookup.name ?? explicit.figmaName ?? "");
    const row = preferredRow(matched, variantParts, explicit.storyId);
    return {
      match: {
        confidence: "exact",
        storybookComponent: row?.title ?? explicit.storybookComponent,
        name: row?.name ?? componentName(explicit.storybookComponent),
        storyId: explicit.storyId ?? row?.storyId,
        suggestedProps: explicit.props ?? inferProps(variantParts),
        importPath: row?.importPath,
        source: "mapping",
      },
      alternatives: [],
    };
  }

  if (!lookup.name) {
    return { match: null, alternatives: [] };
  }

  const { componentName: wanted, variantParts } = splitFigmaName(lookup.name);
  const normalized = wanted.toLowerCase().replace(/\s+/g, "");
  const byTitle = new Map<string, StoryRow[]>();
  for (const row of rows) {
    const group = byTitle.get(row.title) ?? [];
    group.push(row);
    byTitle.set(row.title, group);
  }
  const titles = [...byTitle.keys()];
  const exactTitles = titles.filter((title) => {
    const name = componentName(title).toLowerCase();
    return name === wanted.toLowerCase() || name.replace(/\s+/g, "") === normalized;
  });

  const alternatives = titles
    .filter((title) => !exactTitles.includes(title))
    .map((title) => ({ title, score: similarity(componentName(title).toLowerCase().replace(/\s+/g, ""), normalized) }))
    .filter((item) => item.score > 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((item) => ({
      storybookComponent: item.title,
      confidence: (item.score > 0.85 ? "high" : item.score > 0.7 ? "medium" : "low") as FigmaConfidence,
      reason: `Name similarity ${Math.round(item.score * 100)}%`,
    }));

  if (!exactTitles.length) return { match: null, alternatives };
  const title = exactTitles[0]!;
  const row = preferredRow(byTitle.get(title) ?? [], variantParts);
  return {
    match: row
      ? {
          confidence: variantParts.length ? "medium" : "high",
          storybookComponent: row.title,
          name: row.name,
          storyId: row.storyId,
          suggestedProps: inferProps(variantParts),
          importPath: row.importPath,
          source: "name",
        }
      : null,
    alternatives,
  };
}
