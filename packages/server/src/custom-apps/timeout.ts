export class TimeoutError extends Error {}

/** Reject if `fn` has not settled within `ms`; the timer is always cleared. */
export function withTimeout<T>(ms: number, fn: () => Promise<T>, label = "operation"): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([fn(), timeout]).finally(() => clearTimeout(timer));
}
