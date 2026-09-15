import { resolveExistingFile } from "../workspace/paths";
import type { CdpClient } from "./browser-session";

// Put a workspace file into an <input type="file">.
//
// DOM.setFileInputFiles takes ABSOLUTE, SERVER-SIDE paths, and this works only
// because chromium runs on the same host as the server. That is the assumption
// that breaks first if the browser ever moves to its own pod — at which point
// this needs to become an upload over the wire, not a path.

export type UploadError =
  | "INVALID_NAME"
  | "NOT_FOUND"
  | "NO_SUCH_ELEMENT"
  | "NOT_A_FILE_INPUT";

export class BrowserUploadError extends Error {
  constructor(public readonly code: UploadError, message?: string) {
    super(message ?? code);
    this.name = "BrowserUploadError";
  }
}

interface EvaluateResult {
  result?: { objectId?: string; value?: unknown; type?: string };
  exceptionDetails?: unknown;
}

/**
 * Upload one workspace file into the element matching `selector`.
 *
 * `name` is workspace-relative and resolved server-side. This is an allowlist —
 * the only path that can be produced is one inside the caller's own workspace —
 * and it is not decoration: chromium will upload whatever path it is handed to
 * whatever remote form is on the page, so an absolute path from a tool argument
 * would be an arbitrary-file-exfiltration primitive.
 *
 * resolveExistingFile rather than userFilePath, because this reads bytes: a
 * symlink inside the workspace pointing at the token database satisfies pure
 * path arithmetic and still escapes.
 */
export async function uploadWorkspaceFile(
  page: CdpClient,
  userId: string,
  selector: string,
  name: string
): Promise<{ name: string; path: string }> {
  const abs = await resolveExistingFile(userId, name);
  if (!abs) throw new BrowserUploadError("INVALID_NAME");

  // Runtime is already enabled on this client, and an objectId avoids the
  // nodeId staleness that DOM.getDocument + DOM.querySelector suffers across
  // navigations.
  const found = (await page.send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
  })) as EvaluateResult;

  const objectId = found.result?.objectId;
  if (!objectId) throw new BrowserUploadError("NO_SUCH_ELEMENT", selector);

  // CDP's own complaint for the wrong node type is not something an agent can
  // act on, so check first and say what was actually there.
  const kind = (await page.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function () { return this.tagName + ':' + (this.type || ''); }",
    returnByValue: true,
  })) as EvaluateResult;

  const describe = String(kind.result?.value ?? "");
  if (describe.toUpperCase() !== "INPUT:FILE") {
    throw new BrowserUploadError("NOT_A_FILE_INPUT", describe || "unknown element");
  }

  await page.send("DOM.setFileInputFiles", { objectId, files: [abs] });
  return { name, path: abs };
}
