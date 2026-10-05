import * as vscode from "vscode";
import * as path from "node:path";
import { LanguageClient, TransportKind } from "vscode-languageclient/node";
import type { LanguageClientOptions, ServerOptions } from "vscode-languageclient/node";

import { registerExecution } from "./execution.js";

let client: LanguageClient | undefined;

function tokenKey(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Use an HTTP(S) base URL without embedded credentials, query, or fragment.");
  }
  return `coupl.token:${url.toString().replace(/\/$/, "")}`;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  registerExecution(context, async server => context.secrets.get(tokenKey(server)));
  const serverModule = context.asAbsolutePath(path.join("dist", "server.cjs"));
  const serverOptions: ServerOptions = { run: { module: serverModule, transport: TransportKind.ipc }, debug: { module: serverModule, transport: TransportKind.ipc } };
  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ language: "coupl", scheme: "file" }, { language: "coupl", scheme: "untitled" }],
    synchronize: { configurationSection: "coupl" },
    initializationOptions: { trusted: vscode.workspace.isTrusted, secretStorage: true },
  };
  client = new LanguageClient("coupl", "Coupl", serverOptions, clientOptions);
  context.subscriptions.push(client.onRequest("coupl/token", async ({ serverUrl }: { serverUrl: string }) => {
    if (!vscode.workspace.isTrusted) return null;
    try { return await context.secrets.get(tokenKey(serverUrl)) ?? null; } catch { return null; }
  }));
  const refresh = async () => { await client?.sendNotification("coupl/refreshCatalog"); };
  context.subscriptions.push(vscode.commands.registerCommand("coupl.refreshCatalog", refresh));
  for (const clear of [false, true]) {
    context.subscriptions.push(vscode.commands.registerCommand(clear ? "coupl.clearToken" : "coupl.setToken", async () => {
      if (!vscode.workspace.isTrusted) { void vscode.window.showInformationMessage("Trust the workspace before configuring ComfyUI authentication."); return; }
      const scope = vscode.window.activeTextEditor?.document.uri;
      const serverUrl = vscode.workspace.getConfiguration("coupl", scope).get<string>("serverUrl", "").trim();
      if (!serverUrl) { void vscode.window.showInformationMessage("Set coupl.serverUrl for the active workspace first."); return; }
      try {
        const key = tokenKey(serverUrl);
        if (clear) await context.secrets.delete(key);
        else {
          const value = await vscode.window.showInputBox({ title: `ComfyUI token for ${serverUrl}`, prompt: "Stored in VS Code secret storage.", password: true, ignoreFocusOut: true });
          if (value === undefined) return;
          if (!value.trim()) { void vscode.window.showInformationMessage("Use Coupl: Clear ComfyUI Bearer Token to remove a token."); return; }
          await context.secrets.store(key, value.trim());
        }
        await refresh();
      } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : "Could not update the ComfyUI token."); }
    }));
  }
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(async () => {
    clientOptions.initializationOptions = { trusted: true, secretStorage: true };
    await client?.restart();
  }));
  await client.start();
}

export async function deactivate(): Promise<void> { await client?.stop(); }
