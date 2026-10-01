import { config } from "../config";

// Read at call time, not import time, and tolerate a missing field: many suites
// mock `../src/config` with a hand-built object that has no ADMIN_EMAILS.
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return (config.ADMIN_EMAILS ?? []).includes(email.trim().toLowerCase());
}
