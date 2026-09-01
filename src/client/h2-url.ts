/** Resolve an HTTP/2 connection origin and preserve any configured route prefix. */
export function resolveH2Target(
  baseUrl: string,
  rpcPath: string,
): { origin: string; path: string } {
  const url = new URL(baseUrl);
  const prefix = url.pathname.replace(/\/+$/, "");
  const path = rpcPath.startsWith("/") ? rpcPath : `/${rpcPath}`;
  return { origin: url.origin, path: prefix ? `${prefix}${path}` : path };
}
