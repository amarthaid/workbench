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
