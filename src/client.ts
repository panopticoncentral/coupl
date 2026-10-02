import { isRecord } from "./catalog.js";

export interface CatalogOptions {
  signal?: AbortSignal;
  headers?: HeadersInit;
  timeoutMs?: number;
}

/** Read-only catalog access, shared by the CLI and future browser callers. */
export async function fetchNodeCatalog(server: string, options: CatalogOptions = {}): Promise<Record<string, unknown>> {
  const url = new URL(server);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("The server must be an HTTP(S) base URL without embedded credentials, a query, or a fragment.");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + "/object_info";
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  let response: Response;
  try { response = await fetch(url, { signal, headers: options.headers ?? {}, redirect: "error" }); }
  catch {
    if (timeout.aborted) throw new Error("ComfyUI catalog request timed out.");
    if (options.signal?.aborted) throw new Error("ComfyUI catalog request was cancelled.");
    throw new Error("Could not fetch the ComfyUI catalog; check the server URL, connection, and whether it redirects.");
  }
  if (!response.ok) throw new Error(`ComfyUI catalog request failed (HTTP ${response.status}).`);
  let data: unknown;
  try { data = await response.json(); }
  catch {
    if (timeout.aborted) throw new Error("ComfyUI catalog request timed out.");
    if (options.signal?.aborted) throw new Error("ComfyUI catalog request was cancelled.");
    throw new Error("ComfyUI returned an unreadable JSON catalog.");
  }
  if (!isRecord(data) || Object.keys(data).length === 0 || !Object.values(data).some(v => isRecord(v) && isRecord(v.input) && Array.isArray(v.output))) {
    throw new Error("ComfyUI returned an empty or malformed node catalog.");
  }
  return data;
}
