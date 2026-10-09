import { z } from "zod";
import {
  connectedEntries,
  fetchChunk,
  fetchText,
  findEntry,
  publicEntries,
  storybookUrl,
  type Session,
} from "./client";
import {
  componentName,
  encodeStoryArgs,
  figmaLookup,
  mapFigmaComponent,
  parseFigmaMappings,
  extractArgTypes,
  extractCssVariables,
  extractPlainText,
  extractPresets,
  extractSections,
  renderJsx,
  resolveTitle,
  stylesheetPath,
  type IndexEntry,
} from "./parse";

const INTEGRATION = "storybooks";

function page<T>(rows: T[], limit: number | undefined, offset: number | undefined, max: number, fallback: number): T[] {
  const start = Math.max(0, offset ?? 0);
  const size = Math.min(Math.max(1, limit ?? fallback), max);
  return rows.slice(start, start + size);
}

function matchesQuery(entry: IndexEntry, query: string): boolean {
  const hay = [entry.title, entry.name, entry.id, entry.importPath ?? "", entry.componentPath ?? "", ...entry.tags]
    .join(" ")
    .toLowerCase();
  return hay.includes(query.toLowerCase());
}

function scoreEntry(entry: IndexEntry, query: string): number {
  const hay = [entry.title, entry.name, entry.id, entry.importPath ?? "", ...(entry.tags ?? [])].join(" ").toLowerCase();
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  if (hay.includes(q)) return 1;
  const tokens = q.split(/\s+/).filter(Boolean);
  return tokens.filter((token) => hay.includes(token)).length / tokens.length;
}

function slim(entry: IndexEntry) {
  return {
    id: entry.id,
    title: entry.title,
    name: entry.name,
    type: entry.type,
    tags: entry.tags,
    importPath: entry.importPath ?? null,
    componentPath: entry.componentPath ?? null,
  };
}

function filterEntries(entries: IndexEntry[], args: { query?: string; category?: string; tags?: string[] }): IndexEntry[] {
  return entries.filter((entry) => {
    if (args.category) {
      const cat = args.category.toLowerCase();
      const title = entry.title.toLowerCase();
      if (title !== cat && !title.startsWith(`${cat}/`)) return false;
    }
    if (args.tags?.length && !args.tags.every((tag) => entry.tags.includes(tag))) return false;
    if (args.query && !matchesQuery(entry, args.query)) return false;
    return true;
  });
}

async function componentView(ctx: any, component: string) {
  const { session, entries } = await connectedEntries(ctx);
  const title = resolveTitle(entries, component);
  const matched = entries.filter((entry) => entry.title === title);
  const candidates = [
    matched.find((entry) => entry.type === "docs"),
    ...matched.filter((entry) => entry.type !== "docs"),
  ].filter((entry): entry is IndexEntry => Boolean(entry?.importPath));
  const unique = [...new Map(candidates.map((entry) => [entry.importPath, entry])).values()].slice(0, 3);
  let chunk: string | undefined;
  let argTypes: ReturnType<typeof extractArgTypes> = [];
  let presets: ReturnType<typeof extractPresets> = [];
  for (const entry of unique) {
    const source = await fetchChunk(session, entry.importPath);
    if (!source) continue;
    if (!chunk) chunk = source;
    const found = extractArgTypes(source);
    if (found.length) {
      chunk = source;
      argTypes = found;
      presets = extractPresets(source);
      break;
    }
  }
  const variants = matched.filter((entry) => entry.type !== "docs");
  return {
    session,
    entries,
    title,
    name: componentName(title),
    matched,
    variants,
    chunk,
    argTypes,
    presets,
    importPath: unique[0]?.importPath ?? null,
    componentPath: matched.find((entry) => entry.componentPath)?.componentPath ?? null,
  };
}

export const listStories = {
  name: "storybooks_list_stories",
  description:
    "List stories in the connected Storybook 8 deployment. Metadata only (id, title, name, tags, import path). Filter with query, category (a title prefix such as Components), and tags. Default limit 50, max 200.",
  integration: INTEGRATION,
  inputSchema: z.object({
    query: z.string().optional(),
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const matched = filterEntries(entries, args);
    return { total: matched.length, stories: page(matched, args.limit, args.offset, 200, 50).map(slim) };
  },
};

export const searchStories = {
  name: "storybooks_search_stories",
  description:
    "Search Storybook stories by title, name, id, tags, and import path. Returns the best matches with a score. This searches the index, not the full docs body — use storybooks_get_story for one story's text.",
  integration: INTEGRATION,
  inputSchema: z.object({
    query: z.string().min(1).max(500),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const hits = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, args.query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title));
    const limited = hits.slice(0, args.limit ?? 20);
    return {
      total: hits.length,
      stories: limited.map((hit) => ({ ...slim(hit.entry), score: hit.score })),
    };
  },
};

export const getStoryMetadata = {
  name: "storybooks_get_story_metadata",
  description: "Read one Storybook story's index metadata by story id, without the docs body.",
  integration: INTEGRATION,
  inputSchema: z.object({ storyId: z.string().min(1).max(200) }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    return slim(findEntry(entries, args.storyId));
  },
};

async function storyBody(session: Session, entry: IndexEntry, maxContentLength?: number) {
  const chunk = await fetchChunk(session, entry.importPath);
  const sections = chunk ? extractSections(chunk) : [];
  let content = chunk ? extractPlainText(chunk) : "";
  if (!content) {
    content = `[${entry.type}] ${entry.title} / ${entry.name}`;
  }
  if (maxContentLength && content.length > maxContentLength) content = content.slice(0, maxContentLength);
  return { ...slim(entry), content, sections };
}

export const getStory = {
  name: "storybooks_get_story",
  description:
    "Read one Storybook story, including docs text extracted from its compiled chunk when the static build exposes it. storyId is the index id (for example components-button--primary).",
  integration: INTEGRATION,
  inputSchema: z.object({
    storyId: z.string().min(1).max(200),
    maxContentLength: z.number().int().min(100).max(100_000).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { session, entries } = await connectedEntries(ctx);
    return storyBody(session, findEntry(entries, args.storyId), args.maxContentLength);
  },
};

export const getStorySection = {
  name: "storybooks_get_story_section",
  description: "Read one docs section of a Storybook story. sectionId comes from storybooks_get_story.",
  integration: INTEGRATION,
  inputSchema: z.object({
    storyId: z.string().min(1).max(200),
    sectionId: z.string().min(1).max(200),
  }),
  handler: async (ctx: any, args: any) => {
    const { session, entries } = await connectedEntries(ctx);
    const story = await storyBody(session, findEntry(entries, args.storyId));
    const section = story.sections.find((item) => item.id === args.sectionId);
    if (!section) throw new Error(`Section not found: ${args.sectionId}`);
    return { storyId: story.id, ...section };
  },
};

export const getStoryContext = {
  name: "storybooks_get_story_context",
  description:
    "Short Storybook context for a natural-language question. Ranks index metadata and, for the top matches, includes extracted docs text when a chunk is available.",
  integration: INTEGRATION,
  inputSchema: z.object({
    query: z.string().min(1).max(1000),
    storyId: z.string().min(1).max(200).optional(),
    maxResults: z.number().int().min(1).max(20).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { session, entries } = await connectedEntries(ctx);
    const max = args.maxResults ?? 5;
    let ranked = entries
      .map((entry) => ({ entry, score: scoreEntry(entry, args.query) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score);
    if (args.storyId) {
      const pinned = findEntry(entries, args.storyId);
      ranked = [{ entry: pinned, score: 1 }, ...ranked.filter((hit) => hit.entry.id !== pinned.id)];
    }
    const chosen = ranked.slice(0, max);
    const results = [];
    for (const hit of chosen) {
      const chunk = await fetchChunk(session, hit.entry.importPath);
      const text = (chunk ? extractPlainText(chunk) : "").slice(0, 1500);
      results.push({ ...slim(hit.entry), score: hit.score, content: text || null });
    }
    return { query: args.query, results };
  },
};

export const listComponents = {
  name: "storybooks_list_components",
  description:
    "List Storybook components grouped by story title (for example Components/Button), with variant names. category filters by title prefix. query matches the title.",
  integration: INTEGRATION,
  inputSchema: z.object({
    query: z.string().optional(),
    category: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const byTitle = new Map<string, IndexEntry[]>();
    for (const entry of filterEntries(entries, { category: args.category })) {
      const rows = byTitle.get(entry.title) ?? [];
      rows.push(entry);
      byTitle.set(entry.title, rows);
    }
    let components = [...byTitle.entries()].map(([title, rows]) => ({
      title,
      name: componentName(title),
      category: title.split("/")[0] ?? title,
      variantCount: rows.filter((row) => row.type !== "docs").length,
      variants: rows.filter((row) => row.type !== "docs").map((row) => row.name),
      tags: [...new Set(rows.flatMap((row) => row.tags))],
    }));
    if (args.query) {
      const q = args.query.toLowerCase();
      components = components.filter((item) => item.title.toLowerCase().includes(q) || item.name.toLowerCase().includes(q));
    }
    components.sort((a, b) => a.title.localeCompare(b.title));
    return { total: components.length, components: page(components, args.limit, args.offset, 200, 50) };
  },
};

export const getComponent = {
  name: "storybooks_get_component",
  description:
    "Read one Storybook component by name (Button) or full title (Components/Button): variants, tags, and optional docs text from the overview chunk.",
  integration: INTEGRATION,
  inputSchema: z.object({
    component: z.string().min(1).max(200),
    includeOverviewContent: z.boolean().optional(),
    maxContentLength: z.number().int().min(100).max(100_000).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const view = await componentView(ctx, args.component);
    let overview: string | undefined;
    if (args.includeOverviewContent && view.chunk) {
      overview = extractPlainText(view.chunk);
      if (args.maxContentLength && overview.length > args.maxContentLength) overview = overview.slice(0, args.maxContentLength);
    }
    return {
      title: view.title,
      name: view.name,
      importPath: view.importPath,
      componentPath: view.componentPath,
      variants: view.matched.map((entry) => ({ storyId: entry.id, name: entry.name, type: entry.type })),
      overview: overview ?? null,
    };
  },
};

export const getComponentConfig = {
  name: "storybooks_get_component_config",
  description:
    "Read argTypes (controls, options, descriptions) and story arg presets extracted from a Storybook component's compiled chunk. Use this before inventing props.",
  integration: INTEGRATION,
  inputSchema: z.object({ component: z.string().min(1).max(200) }),
  handler: async (ctx: any, args: any) => {
    const view = await componentView(ctx, args.component);
    const labels = view.variants.map((entry) => entry.name);
    const presets = labels.map((label, index) => ({
      label,
      storyId: view.variants[index]?.id,
      args: view.presets[index] ?? {},
    }));
    return {
      title: view.title,
      name: view.name,
      argTypes: view.argTypes,
      presets,
      note: view.argTypes.length ? undefined : "No argTypes were found in the compiled chunks. The static build may hide story sources.",
    };
  },
};

export const getComponentUsage = {
  name: "storybooks_get_component_usage",
  description:
    "Build a copy-paste JSX example for a Storybook component from its story presets. format is tsx or jsx and only labels the result; the snippet is JSX either way.",
  integration: INTEGRATION,
  inputSchema: z.object({
    componentName: z.string().min(1).max(200),
    variant: z.string().min(1).max(200).optional(),
    format: z.enum(["tsx", "jsx"]).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const view = await componentView(ctx, args.componentName);
    const labels = view.variants.map((entry) => entry.name);
    if (!labels.length) throw new Error(`No story variants found for component: ${args.componentName}`);
    const variants = labels.map((label, index) => {
      const argsForVariant = view.presets[index] ?? {};
      return {
        name: label,
        storyId: view.variants[index]?.id,
        args: argsForVariant,
        code: renderJsx(view.name, argsForVariant),
      };
    });
    const selected =
      (args.variant && variants.find((item) => item.name.toLowerCase() === String(args.variant).toLowerCase())) || variants[0]!;
    const from = view.componentPath ?? view.importPath ?? view.name;
    const importHint = `import { ${view.name} } from ${JSON.stringify(from)};`;
    return {
      component: view.name,
      format: args.format ?? "tsx",
      importHint,
      primary: selected,
      fullExample: `${importHint}\n\n${selected.code}`,
      variants,
    };
  },
};

export const findStoriesBySource = {
  name: "storybooks_find_stories_by_source",
  description: "Find Storybook stories whose importPath or componentPath contains the given source file path.",
  integration: INTEGRATION,
  inputSchema: z.object({ sourceFile: z.string().min(1).max(500) }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const needle = String(args.sourceFile).replace(/^\.\//, "").toLowerCase();
    const stories = entries.filter((entry) => {
      const paths = [entry.importPath, entry.componentPath].filter(Boolean).join(" ").toLowerCase();
      return paths.includes(needle);
    });
    return { total: stories.length, stories: stories.map(slim) };
  },
};

export const previewStory = {
  name: "storybooks_preview_story",
  description:
    "Build a Storybook iframe URL for a story, with optional args and globals encoded the way Storybook's iframe expects. The URL stays on the connected origin.",
  integration: INTEGRATION,
  inputSchema: z.object({
    storyId: z.string().min(1).max(200),
    args: z.record(z.unknown()).optional(),
    globals: z.record(z.unknown()).optional(),
    viewport: z
      .object({
        width: z.number().int().min(1).max(10_000),
        height: z.number().int().min(1).max(10_000),
      })
      .optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { session, entries } = await connectedEntries(ctx);
    const story = findEntry(entries, args.storyId);
    const params = new URLSearchParams();
    params.set("id", story.id);
    params.set("viewMode", story.type === "docs" ? "docs" : "story");
    if (args.args && Object.keys(args.args).length) params.set("args", encodeStoryArgs(args.args));
    if (args.globals && Object.keys(args.globals).length) params.set("globals", encodeStoryArgs(args.globals));
    const manager = new URLSearchParams({ path: `/${story.type === "docs" ? "docs" : "story"}/${story.id}` });
    return {
      storyId: story.id,
      storyTitle: `${story.title} / ${story.name}`,
      previewUrl: storybookUrl(session.baseUrl, `iframe.html?${params.toString()}`),
      managerUrl: storybookUrl(session.baseUrl, `?${manager.toString()}`),
      viewport: args.viewport ?? null,
    };
  },
};

export const getCatalogSummary = {
  name: "storybooks_get_catalog_summary",
  description:
    "Compact Storybook catalog: component title, name, variant count, and tags. Call this before building new UI so an existing component is reused. category limits the title prefix.",
  integration: INTEGRATION,
  inputSchema: z.object({
    category: z.string().min(1).max(200).optional(),
    maxDescriptionLength: z.number().int().min(0).max(1000).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const filtered = filterEntries(entries, { category: args.category });
    const byTitle = new Map<string, IndexEntry[]>();
    for (const entry of filtered) {
      const rows = byTitle.get(entry.title) ?? [];
      rows.push(entry);
      byTitle.set(entry.title, rows);
    }
    const max = args.maxDescriptionLength ?? 160;
    const components = [...byTitle.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([title, rows]) => {
        const description = rows
          .map((row) => row.name)
          .filter(Boolean)
          .join(", ");
        return {
          title,
          name: componentName(title),
          variants: rows.filter((row) => row.type !== "docs").length,
          tags: [...new Set(rows.flatMap((row) => row.tags))].slice(0, 8),
          description: max === 0 ? "" : description.slice(0, max),
        };
      });
    return { total: components.length, components };
  },
};

export const getDesignTokens = {
  name: "storybooks_get_design_tokens",
  description:
    "CSS custom properties from stylesheets linked by the Storybook iframe. category is colors, spacing, typography, shadows, radius, breakpoints, motion, z-index, other, or all.",
  integration: INTEGRATION,
  inputSchema: z.object({
    category: z
      .enum(["colors", "spacing", "typography", "breakpoints", "shadows", "radius", "motion", "z-index", "other", "all"])
      .optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { session } = await connectedEntries(ctx);
    const html = await fetchText(session, "iframe.html");
    const paths = [...html.matchAll(/<link[^>]+href="([^"]+)"/gi)]
      .map((match) => stylesheetPath(match[1] ?? ""))
      .filter((path): path is string => Boolean(path))
      .slice(0, 15);
    if (!paths.length) throw new Error("No stylesheets found in the Storybook iframe");
    const tokens = [];
    const sources: string[] = [];
    const seen = new Set<string>();
    for (const path of paths) {
      try {
        const css = await fetchText(session, path);
        const extracted = extractCssVariables(css);
        if (!extracted.length) continue;
        sources.push(path);
        for (const token of extracted) {
          if (seen.has(token.name)) continue;
          seen.add(token.name);
          tokens.push(token);
        }
      } catch {
        // One broken stylesheet should not hide the rest.
      }
    }
    const category = args.category ?? "all";
    const filtered = category === "all" ? tokens : tokens.filter((token) => token.category === category);
    filtered.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
    return { total: filtered.length, sources, tokens: filtered };
  },
};

export const compareVersions = {
  name: "storybooks_compare_versions",
  description:
    "Diff the connected Storybook against another deployment's index: added, removed, and changed component titles. The other URL is fetched with no credential, so it must be public, and it must be an http(s) host that is not a private address.",
  integration: INTEGRATION,
  inputSchema: z.object({
    otherUrl: z.string().url().max(500),
    components: z.array(z.string().min(1).max(200)).max(100).optional(),
  }),
  handler: async (ctx: any, args: any) => {
    const { session, entries } = await connectedEntries(ctx);
    const other = await publicEntries(args.otherUrl);
    const wanted = args.components as string[] | undefined;
    const keep = (entry: IndexEntry) => {
      if (entry.type === "docs") return false;
      if (!wanted?.length) return true;
      return wanted.some((name) => entry.title === name || entry.title.endsWith(`/${name}`) || componentName(entry.title) === name);
    };
    const group = (rows: IndexEntry[]) => {
      const map = new Map<string, string[]>();
      for (const entry of rows.filter(keep)) {
        const names = map.get(entry.title) ?? [];
        if (entry.name) names.push(entry.name);
        map.set(entry.title, names);
      }
      return map;
    };
    const base = group(entries);
    const target = group(other);
    const added = [...target.keys()].filter((title) => !base.has(title)).sort();
    const removed = [...base.keys()].filter((title) => !target.has(title)).sort();
    const changed = [...base.keys()]
      .filter((title) => target.has(title))
      .filter((title) => {
        const left = [...(base.get(title) ?? [])].sort().join("\n");
        const right = [...(target.get(title) ?? [])].sort().join("\n");
        return left !== right;
      })
      .sort()
      .map((title) => ({
        title,
        connectedVariants: base.get(title) ?? [],
        otherVariants: target.get(title) ?? [],
      }));
    return { connected: session.baseUrl, other: args.otherUrl, added, removed, changed };
  },
};

export const mapFigma = {
  name: "storybooks_map_figma_component",
  description:
    "Map a Figma component onto a Storybook component before writing UI. Pass figmaName (Button or Button / Primary), figmaNodeId, or a figmaUrl with node-id. An exact row in the connection's figmaMappings wins; otherwise the name is matched against story titles. Does not call the Figma API. Use the returned storyId with storybooks_get_component_config.",
  integration: INTEGRATION,
  inputSchema: z
    .object({
      figmaName: z.string().min(1).max(500).optional(),
      figmaNodeId: z.string().min(1).max(200).optional(),
      figmaUrl: z.string().url().max(1000).optional(),
    })
    .refine((value) => value.figmaName || value.figmaNodeId || value.figmaUrl, {
      message: "Pass figmaName, figmaNodeId, or figmaUrl",
    }),
  handler: async (ctx: any, args: any) => {
    const { entries } = await connectedEntries(ctx);
    const raw = ctx.getConfig?.().figmaMappings;
    const mappings = typeof raw === "string" && raw.trim() ? parseFigmaMappings(raw) : [];
    const lookup = figmaLookup(args);
    const mapped = mapFigmaComponent(entries, lookup, mappings);
    return {
      query: lookup,
      match: mapped.match,
      alternatives: mapped.alternatives,
      note: mapped.match
        ? undefined
        : lookup.nodeId && !lookup.name
          ? "No figmaMappings row for this node id. Add one on the Storybooks connection, or pass figmaName."
          : "No Storybook component matched this Figma name. Add a figmaMappings row or rename the Figma component to the Storybook name.",
    };
  },
};

export const getStoryInstructions = {
  name: "storybooks_get_story_instructions",
  description:
    "CSF3 authoring notes for this Storybook: reuse catalog components, copy props from storybooks_get_component_config, and match an existing story's title prefix.",
  integration: INTEGRATION,
  inputSchema: z.object({}),
  handler: async (ctx: any) => {
    const { entries } = await connectedEntries(ctx);
    const titles = entries.map((entry) => entry.title);
    const prefixCounts = new Map<string, number>();
    for (const title of titles) {
      const prefix = title.split("/")[0] ?? title;
      prefixCounts.set(prefix, (prefixCounts.get(prefix) ?? 0) + 1);
    }
    const prefix = [...prefixCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Components";
    return {
      format: "CSF3",
      titlePrefix: prefix,
      guide: [
        `Title new stories under "${prefix}/ComponentName", matching the majority of this Storybook.`,
        "Default export: { title, component, tags: ['autodocs'] }.",
        "One named export per variant. Put visual props in args, not in the story function.",
        "Read storybooks_get_component_config before adding a prop that already exists.",
        "Read storybooks_get_catalog_summary before creating a component that may already exist.",
        "The tool returns text only. Write the file in the repo yourself.",
      ],
    };
  },
};
