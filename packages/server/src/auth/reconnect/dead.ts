import type { CookieSessionConfig } from "@a-workbench/shared";

export function matchesDead(
  res: Response,
  rule: CookieSessionConfig["dead"],
  requestUrl: string
): boolean {
  if (!rule.status.includes(res.status)) return false;
  if (!rule.redirectTo || res.status < 300 || res.status >= 400) return true;
  const loc = res.headers.get("location");
  if (!loc) return false;
  try {
    return new URL(loc, requestUrl).pathname.startsWith(rule.redirectTo);
  } catch {
    return false;
  }
}
