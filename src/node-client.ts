import WebSocket from "ws";
import { ComfyClient } from "./execution.js";
import type { ExecutionClientOptions, ProgressTransport } from "./execution.js";

/** Node transport supports Authorization on the upgrade request without exposing tokens in URLs. */
export const nodeProgressTransport: ProgressTransport = (url, headers, receive, signal) => new Promise((resolve, reject) => {
  if (signal.aborted) { reject(signal.reason); return; }
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { requestHeaders[name] = value; });
  const socket = new WebSocket(url, { headers: requestHeaders, followRedirects: false, handshakeTimeout: 5000 });
  const stop = () => { signal.removeEventListener("abort", stop); socket.terminate(); };
  signal.addEventListener("abort", stop, { once: true });
  socket.once("open", () => resolve(stop));
  socket.on("error", () => reject(new Error("Live progress connection failed.")));
  socket.once("close", () => { signal.removeEventListener("abort", stop); reject(new Error("Live progress connection closed.")); });
  socket.on("message", (data, binary) => {
    if (binary) return;
    let message: unknown;
    try { message = JSON.parse(data.toString()); } catch { return; }
    receive(message);
  });
});

export function createComfyClient(server: string, options: ExecutionClientOptions = {}): ComfyClient {
  return new ComfyClient(server, { ...options, progressTransport: options.progressTransport ?? nodeProgressTransport });
}
