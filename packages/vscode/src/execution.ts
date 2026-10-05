import * as vscode from "vscode";
import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { compile, ExecutionError, fetchNodeCatalog, parse } from "coupl";
import type { Span, NodeIssue, RunResult } from "coupl";
import { createComfyClient } from "coupl/node";

function range(span: Span): vscode.Range {
  return new vscode.Range(span.start.line - 1, span.start.column - 1, span.end.line - 1, span.end.column - 1);
}
function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function registerExecution(context: vscode.ExtensionContext, tokenFor: (server: string) => Promise<string | undefined>): void {
  const log = vscode.window.createOutputChannel("Coupl Runs");
  const diagnostics = vscode.languages.createDiagnosticCollection("coupl-execution");
  const snapshots = new Map<string, string>();
  let active: AbortController | undefined;
  context.subscriptions.push(log, diagnostics,
    vscode.workspace.registerTextDocumentContentProvider("coupl-run", { provideTextDocumentContent: uri => snapshots.get(uri.toString()) ?? "" }),
    vscode.workspace.onDidChangeTextDocument(event => diagnostics.delete(event.document.uri)),
    vscode.workspace.onDidCloseTextDocument(document => {
      if (document.uri.scheme === "coupl-run") { snapshots.delete(document.uri.toString()); diagnostics.delete(document.uri); }
    }),
    { dispose: () => active?.abort() },
    vscode.commands.registerCommand("coupl.stopMonitoring", () => active?.abort()),
    vscode.commands.registerCommand("coupl.run", async () => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage("Trust the workspace before running a workflow."); return; }
      const document = vscode.window.activeTextEditor?.document;
      if (!document || document.languageId !== "coupl" || !["file", "untitled"].includes(document.uri.scheme)) {
        void vscode.window.showInformationMessage("Open a Coupl source file to run it."); return;
      }
      if (active) { void vscode.window.showInformationMessage("A Coupl run is already being monitored."); return; }
      const source = document.getText();
      const version = document.version;
      const config = vscode.workspace.getConfiguration("coupl", document.uri);
      const server = config.get<string>("serverUrl", "").trim();
      if (!server) { void vscode.window.showInformationMessage("Set coupl.serverUrl before running a workflow."); return; }
      const controller = new AbortController(); active = controller;
      await vscode.commands.executeCommand("setContext", "coupl.running", true);
      const parsed = parse(source);
      const snapshotUri = vscode.Uri.parse(`coupl-run:/${randomUUID()}/${encodeURIComponent(basename(document.uri.path) || "workflow.coupl")}`);
      snapshots.set(snapshotUri.toString(), source);
      const target = () => !document.isClosed && document.version === version ? document.uri : snapshotUri;
      const setIssues = (issues: NodeIssue[]) => {
        const uri = target();
        diagnostics.set(uri, issues.map(issue => {
          const node = parsed.declarations.find(declaration => declaration.name === issue.node);
          const diagnostic = new vscode.Diagnostic(node ? range(node.span) : new vscode.Range(0, 0, 0, 0), `${issue.node}: ${issue.message}`, vscode.DiagnosticSeverity.Error);
          diagnostic.source = "Coupl execution";
          return diagnostic;
        }));
        return uri;
      };
      diagnostics.delete(document.uri);
      log.show(true);
      log.appendLine(`Run ${document.uri.toString()}`);
      try {
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "Coupl workflow", cancellable: false }, async progress => {
          if (parsed.diagnostics.length) {
            diagnostics.set(document.uri, parsed.diagnostics.map(item => new vscode.Diagnostic(range(item.span), item.message, vscode.DiagnosticSeverity.Error)));
            throw new Error("Fix the source errors before running.");
          }
          progress.report({ message: "Checking the server catalog…" });
          const token = await tokenFor(server);
          const headers = token ? { Authorization: `Bearer ${token}` } : {};
          const catalog = await fetchNodeCatalog(server, { headers, signal: controller.signal });
          const compiled = compile(source, catalog);
          diagnostics.set(target(), compiled.diagnostics.map(item => new vscode.Diagnostic(range(item.span), item.message,
            item.severity === "error" ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning)));
          if (!compiled.ok) throw new Error("Fix the source errors before running.");
          const client = createComfyClient(server, { headers });
          const result = await client.run(compiled.graph, { signal: controller.signal, timeoutMs: config.get<number>("runTimeoutSeconds", 3600) * 1000, onEvent: event => {
            if (event.type === "queued") {
              log.appendLine(`Queued ${event.promptId}`);
              progress.report({ message: "Queued" });
              for (const issue of event.issues ?? []) log.appendLine(`Server warning: ${issue.node}: ${issue.message}`);
            } else if (event.type === "executing") {
              progress.report({ message: `Executing ${event.node}` }); log.appendLine(`Executing ${event.node}`);
            } else if (event.type === "progress") progress.report({ message: `${event.node ?? "Progress"}: ${event.value}/${event.max}` });
            else if (event.message) { log.appendLine(event.message); progress.report({ message: event.message }); }
          } });
          log.appendLine(`Completed ${result.promptId}`);
          progress.report({ message: "Loading outputs…" });
          await showResults(context, result, client, controller.signal, log);
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Workflow execution failed.";
        log.appendLine(message);
        if (error instanceof ExecutionError && error.promptId) log.appendLine(`Prompt: ${error.promptId}`);
        if (error instanceof ExecutionError && error.issues.length) {
          const uri = setIssues(error.issues);
          const first = diagnostics.get(uri)?.[0];
          await vscode.window.showTextDocument(uri, { ...(first ? { selection: first.range } : {}), preview: true });
        }
        void vscode.window.showErrorMessage(`Coupl: ${message}`);
      } finally {
        if (!vscode.workspace.textDocuments.some(open => open.uri.toString() === snapshotUri.toString()) && !diagnostics.get(snapshotUri)?.length) snapshots.delete(snapshotUri.toString());
        active = undefined;
        await vscode.commands.executeCommand("setContext", "coupl.running", false);
      }
    }),
  );
}

async function showResults(context: vscode.ExtensionContext, result: RunResult, client: ReturnType<typeof createComfyClient>, signal: AbortSignal, log: vscode.OutputChannel): Promise<void> {
  const directory = vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, "runs", randomUUID());
  await vscode.workspace.fs.createDirectory(directory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(directory, "result.json"), Buffer.from(JSON.stringify(result, null, 2)));
  const files: { uri: vscode.Uri; name: string; node: string }[] = [];
  const errors: string[] = [];
  for (const [index, file] of result.files.entries()) {
    const name = `${index + 1}-${basename(file.filename.replaceAll("\\", "/")).replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const uri = vscode.Uri.joinPath(directory, name);
    try { await vscode.workspace.fs.writeFile(uri, await client.download(file, signal)); files.push({ uri, name, node: file.node }); }
    catch (error) {
      const message = `${name}: ${error instanceof Error ? error.message : "Could not download output."}`;
      errors.push(message); log.appendLine(message);
    }
  }
  const panel = vscode.window.createWebviewPanel("coupl.results", "Coupl Results", vscode.ViewColumn.Beside, { enableScripts: true, localResourceRoots: [directory] });
  const nonce = randomUUID().replaceAll("-", "");
  panel.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"><style nonce="${nonce}">
body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 16px; } img { max-width: 100%; max-height: 65vh; } pre { white-space: pre-wrap; overflow-wrap: anywhere; } article { margin: 24px 0; } button { margin-right: 8px; cursor: pointer; }
</style></head><body><h1>Workflow completed</h1><p>Prompt: ${escape(result.promptId)}</p>
${errors.map(message => `<p>Download failed: ${escape(message)}</p>`).join("")}
${files.length ? files.map((file, index) => `<article><h2>${escape(file.node)} · ${escape(file.name)}</h2>${/\.(png|jpe?g|webp|gif)$/i.test(file.name) ? `<img src="${escape(panel.webview.asWebviewUri(file.uri).toString())}" alt="${escape(file.name)}">` : ""}<p><button data-action="open" data-index="${index}">Open</button><button data-action="save" data-index="${index}">Save As…</button></p></article>`).join("") : "<p>No downloaded files. Node outputs are shown below.</p>"}
<details${files.length ? "" : " open"}><summary>Node outputs</summary><pre>${escape(JSON.stringify(result.outputs, null, 2))}</pre></details>
<script nonce="${nonce}">const vscode = acquireVsCodeApi(); document.addEventListener('click', event => { const button = event.target.closest('button'); if (button) vscode.postMessage({ action: button.dataset.action, index: Number(button.dataset.index) }); });</script></body></html>`;
  const listener = panel.webview.onDidReceiveMessage(async message => {
    if (!message || !Number.isInteger(message.index)) return;
    const file = files[message.index]; if (!file) return;
    try {
      if (message.action === "open") await vscode.commands.executeCommand("vscode.open", file.uri);
      if (message.action === "save") {
        const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
        const destination = await vscode.window.showSaveDialog({ defaultUri: folder ? vscode.Uri.joinPath(folder, file.name) : vscode.Uri.file(file.name), saveLabel: "Save output" });
        if (destination) await vscode.workspace.fs.copy(file.uri, destination, { overwrite: true });
      }
    } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not open or save output."); }
  });
  panel.onDidDispose(() => listener.dispose());
  context.subscriptions.push(panel, listener);
}
