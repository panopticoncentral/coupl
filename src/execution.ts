import { isRecord } from "./catalog.js";
import type { ApiGraph } from "./types.js";
import type { CatalogOptions } from "./client.js";

export interface NodeIssue { node: string; message: string }
export class ExecutionError extends Error {
  constructor(message: string, readonly issues: NodeIssue[] = [], readonly promptId?: string) {
    super(message);
    this.name = "ExecutionError";
  }
}
class RequestFailure extends ExecutionError {}

export interface OutputFile { node: string; filename: string; subfolder: string; type: "output" | "temp" | "input" }
export interface RunResult { promptId: string; outputs: Record<string, unknown>; files: OutputFile[] }
export interface RunEvent {
  type: "queued" | "executing" | "progress" | "connection";
  promptId?: string;
  node?: string;
  value?: number;
  max?: number;
  message?: string;
  issues?: NodeIssue[];
}
/** The transport must not follow redirects or include credentials in its URL. */
export type ProgressTransport = (url: URL, headers: Headers, receive: (message: unknown) => void, signal: AbortSignal) => Promise<() => void>;
export interface ExecutionClientOptions extends CatalogOptions { progressTransport?: ProgressTransport }
export interface RunOptions {
  signal?: AbortSignal;
  /** Overall monitoring deadline, including queue time. Default: one hour. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  onEvent?: (event: RunEvent) => void;
}

function baseUrl(server: string): URL {
  const url = new URL(server);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) base URL without embedded credentials, query, or fragment.");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}
function describe(value: unknown): string {
  if (!isRecord(value)) return "ComfyUI rejected the workflow.";
  return [value.message, value.details].filter(v => typeof v === "string" && v).join(": ").slice(0, 4000) || "ComfyUI rejected the workflow.";
}
function nodeIssues(value: unknown): NodeIssue[] {
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([node, info]) => isRecord(info) && Array.isArray(info.errors)
    ? info.errors.map(error => ({ node, message: describe(error) })) : []);
}
function executionFailure(data: Record<string, unknown>, promptId: string): ExecutionError {
  const message = typeof data.exception_message === "string" ? data.exception_message.slice(0, 4000) : "Workflow execution was interrupted or failed.";
  const node = typeof data.node_id === "string" ? data.node_id : undefined;
  return new ExecutionError(message, node ? [{ node, message }] : [], promptId);
}
function outputFiles(outputs: Record<string, unknown>): OutputFile[] {
  const files: OutputFile[] = [];
  const seen = new Set<string>();
  for (const [node, output] of Object.entries(outputs)) {
    if (!isRecord(output)) continue;
    for (const values of Object.values(output)) {
      if (!Array.isArray(values)) continue;
      for (const file of values) {
        if (!isRecord(file) || typeof file.filename !== "string" || !file.filename ||
          (file.type !== "output" && file.type !== "temp" && file.type !== "input")) continue;
        const subfolder = typeof file.subfolder === "string" ? file.subfolder : "";
        const key = JSON.stringify([file.filename, subfolder, file.type]);
        if (seen.has(key)) continue;
        seen.add(key);
        files.push({ node, filename: file.filename, subfolder, type: file.type });
      }
    }
  }
  return files;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function validateMonitoring(options: RunOptions): void {
  for (const value of [options.timeoutMs ?? 3_600_000, options.pollIntervalMs ?? 1000]) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) throw new Error("Monitoring timeout and poll interval must be positive integer milliseconds no greater than 2147483647.");
  }
}

/** HTTP execution and artifact access; the compiler remains independent of I/O. */
export class ComfyClient {
  private readonly base: URL;
  private readonly headers: Headers;
  constructor(server: string, private readonly options: ExecutionClientOptions = {}) {
    this.base = baseUrl(server);
    this.headers = new Headers(options.headers);
  }
  private url(path: string): URL {
    const url = new URL(this.base);
    url.pathname = url.pathname.replace(/\/$/, "") + path;
    return url;
  }
  private async request<T>(url: URL, init: RequestInit, signal: AbortSignal | undefined, read: (response: Response) => Promise<T>): Promise<T> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 15_000);
    const signals = [deadline, signal, this.options.signal].filter((s): s is AbortSignal => !!s);
    const combined = AbortSignal.any(signals);
    const headers = new Headers(this.headers);
    new Headers(init.headers).forEach((value, name) => headers.set(name, value));
    try {
      const response = await fetch(url, { ...init, headers, signal: combined, redirect: "error" });
      return await read(response);
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if (combined.aborted) throw new RequestFailure(deadline.aborted ? "ComfyUI request timed out." : "Monitoring stopped; submitted work may still run on ComfyUI.");
      throw new RequestFailure("Could not read the ComfyUI response; check the connection and server URL.");
    }
  }
  private json(path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<Record<string, unknown>> {
    return this.request(this.url(path), init, signal, async response => {
      if (!response.ok) throw new ExecutionError(`ComfyUI request failed (HTTP ${response.status}).`);
      const data: unknown = await response.json();
      if (!isRecord(data)) throw new ExecutionError("ComfyUI returned a malformed response.");
      return data;
    });
  }
  async submit(graph: ApiGraph, clientId: string, signal?: AbortSignal): Promise<{ promptId: string; issues: NodeIssue[] }> {
    try {
      return await this.request(this.url("/prompt"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: graph, client_id: clientId }) }, signal, async response => {
        // Only prompt validation responses are safe/useful to expose as server diagnostics.
        if (!response.ok && response.status !== 400) throw new ExecutionError(`ComfyUI submission failed (HTTP ${response.status}); acceptance is unknown. Check the server queue before retrying.`);
        const data: unknown = await response.json();
        if (!isRecord(data)) throw new Error("Malformed submission response");
        const issues = nodeIssues(data.node_errors);
        if (response.status === 400 || data.error) throw new ExecutionError(describe(data.error), issues);
        if (typeof data.prompt_id !== "string" || !data.prompt_id) throw new Error("Missing prompt id");
        return { promptId: data.prompt_id, issues };
      });
    } catch (error) {
      if (!(error instanceof RequestFailure)) throw error;
      throw new ExecutionError("Submission outcome is unknown. Check ComfyUI's queue/history before retrying; the request was not retried automatically.");
    }
  }
  async download(file: OutputFile, signal?: AbortSignal): Promise<Uint8Array> {
    const url = this.url("/view");
    url.search = new URLSearchParams({ filename: file.filename, subfolder: file.subfolder, type: file.type }).toString();
    return this.request(url, {}, signal, async response => {
      if (!response.ok) throw new ExecutionError(`ComfyUI output download failed (HTTP ${response.status}).`);
      return new Uint8Array(await response.arrayBuffer());
    });
  }
  /** Aborting stops monitoring; it deliberately does not interrupt other server work. */
  async run(graph: ApiGraph, options: RunOptions = {}): Promise<RunResult> {
    validateMonitoring(options);
    const lifetime = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, ...[options.signal, this.options.signal].filter((s): s is AbortSignal => !!s)]);
    let close: (() => void) | undefined;
    const clientId = crypto.randomUUID();
    let promptId: string | undefined;
    let failure: ExecutionError | undefined;
    const pending: unknown[] = [];
    const emit = (event: RunEvent) => {
      try { options.onEvent?.(event); }
      catch { failure = new ExecutionError("Run event handler failed; monitoring stopped and server work may continue.", [], promptId); }
    };
    const receive = (message: unknown) => {
      if (!promptId) { if (pending.length < 256) pending.push(message); return; }
      if (!isRecord(message) || !isRecord(message.data) || message.data.prompt_id !== promptId) return;
      const data = message.data;
      if (message.type === "execution_error" || message.type === "execution_interrupted") failure = executionFailure(data, promptId);
      if (message.type === "executing" && typeof data.node === "string") emit({ type: "executing", promptId, node: data.node });
      if (message.type === "progress" && typeof data.value === "number" && typeof data.max === "number") {
        emit({ type: "progress", promptId, ...(typeof data.node === "string" ? { node: data.node } : {}), value: data.value, max: data.max });
      }
    };
    try {
      signal.throwIfAborted();
      if (this.options.progressTransport) {
        const url = this.url("/ws"); url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.searchParams.set("clientId", clientId);
        try { close = await this.options.progressTransport(url, new Headers(this.headers), receive, signal); }
        catch { emit({ type: "connection", message: "Live progress unavailable; monitoring history." }); }
      }
      signal.throwIfAborted();
      if (failure) throw failure;
      const submitted = await this.submit(graph, clientId, signal);
      promptId = submitted.promptId;
      emit({ type: "queued", promptId, issues: submitted.issues });
      for (const message of pending) receive(message);
      return await this.monitor(promptId, { ...options, signal, onEvent: emit }, () => failure);
    } finally { lifetime.abort(); close?.(); }
  }
  /** Resume monitoring a known prompt without submitting it again. */
  async wait(promptId: string, options: RunOptions = {}): Promise<RunResult> {
    return this.monitor(promptId, options);
  }
  private async monitor(promptId: string, options: RunOptions, failure?: () => ExecutionError | undefined): Promise<RunResult> {
    const timeoutMs = options.timeoutMs ?? 3_600_000;
    const interval = options.pollIntervalMs ?? 1000;
    validateMonitoring(options);
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([deadline, ...[options.signal, this.options.signal].filter((s): s is AbortSignal => !!s)]);
    let failures = 0;
    try {
      while (true) {
        signal.throwIfAborted();
        const runtimeError = failure?.();
        if (runtimeError) throw runtimeError;
        let history: Record<string, unknown>;
        try { history = await this.json(`/history/${encodeURIComponent(promptId)}`, {}, signal); failures = 0; }
        catch (error) {
          signal.throwIfAborted();
          if (++failures >= 3) throw error;
          options.onEvent?.({ type: "connection", promptId, message: "Connection interrupted; retrying history lookup." });
          await pause(Math.min(interval * failures, 2_147_483_647), signal); continue;
        }
        const entry = history[promptId];
        if (isRecord(entry)) {
          const status = entry.status;
          if (!isRecord(status)) throw new ExecutionError("ComfyUI history has no execution status.", [], promptId);
          const messages = Array.isArray(status.messages) ? status.messages : [];
          const failed = [...messages].reverse().find(message => Array.isArray(message) && ["execution_error", "execution_interrupted"].includes(message[0]));
          if (Array.isArray(failed) && isRecord(failed[1])) throw executionFailure(failed[1], promptId);
          if (status.status_str === "error") throw new ExecutionError("Workflow execution failed.", [], promptId);
          if (status.completed === true && status.status_str === "success") {
            if (!isRecord(entry.outputs)) throw new ExecutionError("ComfyUI returned malformed outputs.", [], promptId);
            return { promptId, outputs: entry.outputs, files: outputFiles(entry.outputs) };
          }
        }
        await pause(interval, signal);
      }
    } catch (error) {
      if (signal.aborted) throw new ExecutionError(deadline.aborted ? "Monitoring timed out; submitted work may still run on ComfyUI." : "Monitoring stopped; submitted work may still run on ComfyUI.", [], promptId);
      if (error instanceof ExecutionError) throw new ExecutionError(error.message, error.issues, promptId);
      throw error;
    }
  }
}
