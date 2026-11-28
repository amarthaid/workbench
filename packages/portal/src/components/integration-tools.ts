import type { IntegrationDetail } from "../api";
import type { SpaceTool } from "../spaces-api";

/**
 * An app's tools in the shape the shared tools accordion takes. The accordion
 * only needs the name, the effect and the description; none are missing.
 * A tool without an effect is shown as destructive, the same default the
 * server applies.
 */
export function integrationTools(detail: Pick<IntegrationDetail, "name" | "displayName" | "tools">): SpaceTool[] {
  return detail.tools.map((t) => ({
    name: t.name,
    integration: detail.name,
    integrationName: detail.displayName || detail.name,
    effect: t.effect,
    description: t.description,
  }));
}
