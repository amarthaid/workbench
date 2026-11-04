/** TRUST_PROXY (config.ts) as Fastify's `trustProxy`; a hop count becomes "trust the first N hops". */
export function trustProxyOption(
  t: boolean | number | string[] | undefined
): { trustProxy?: boolean | string[] | ((addr: string, i: number) => boolean) } {
  if (t === undefined) return {};
  if (typeof t === "number") return { trustProxy: (_addr: string, i: number) => i < t };
  return { trustProxy: t };
}
