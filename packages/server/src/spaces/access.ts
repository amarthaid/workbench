import { isSharedWith, normalizeEmail, type Space } from "./store";

export interface Viewer {
  userId: string;
  email: string | null;
}

/**
 * Who may open a Space: its owner; anyone signed in when visibility is "org";
 * a listed email (case-insensitive) when it is "users". Admins get no
 * exception: opening a Space runs its code as the viewer, which is not an
 * admin power. Admins list and delete through the agent tools instead.
 */
export async function canView(space: Space, viewer: Viewer): Promise<boolean> {
  if (space.ownerId === viewer.userId) return true;
  if (space.visibility === "org") return true;
  if (space.visibility === "users" && viewer.email) {
    return isSharedWith(space.name, normalizeEmail(viewer.email));
  }
  return false;
}
