# Coupl for Visual Studio Code

Language support for `.coupl` files describing ComfyUI workflows.

## Features

- Syntax highlighting, comments, bracket matching, and indentation.
- Live syntax and compiler diagnostics, including related declaration locations.
- Completion for node classes, named inputs, enum/model choices, and output ports.
- Hover information for nodes and inputs, call signature help, and go-to-definition for local node references.
- Recovery for unfinished calls and dynamic maps while typing.
- Per-workspace ComfyUI catalogs, saved JSON catalogs for offline use, and an explicit refresh command.

The extension bundles the compiler and a separate language server. Installing the VSIX requires no separate Node.js or Coupl installation. VS Code 1.101 or newer is required.

## Configure a catalog

Set **Coupl: Server Url** in workspace settings to the ComfyUI base URL, for example:

```json
{
  "coupl.serverUrl": "http://localhost:8188"
}
```

While editing, the extension reads `/object_info` and checks source locally. Explicitly running a workflow submits its compiled API graph to ComfyUI; the Coupl source itself is not sent. Custom node classes and model choices follow the configured instance.

Alternatively, set **Coupl: Catalog Path** to a saved `/object_info` response:

```json
{
  "coupl.catalogPath": "catalog/object_info.json"
}
```

Paths may be absolute or relative to the document's workspace folder. If both settings are supplied, the server is preferred and the saved catalog is an offline fallback. Folders in a multi-root workspace can use different settings. Documents outside workspace folders require an absolute catalog path.

Catalogs are cached in memory, not fetched on every edit. Run **Coupl: Refresh Node Catalog** after installing nodes or models, changing a saved catalog, or recovering connectivity. A failed refresh retains the last successful catalog and displays a status in Problems. The cache lasts until the language server restarts; use a saved catalog for offline use across restarts. Without a catalog, syntax checking and local definitions remain available.

For authentication, run **Coupl: Set ComfyUI Bearer Token** with a document from the intended workspace active. The token is stored in VS Code secret storage for that server URL. Use **Coupl: Clear ComfyUI Bearer Token** to remove it. URLs cannot contain embedded credentials, query parameters, or fragments. Catalog reads require a trusted workspace.

## Run workflows

Set `coupl.serverUrl`, open a `.coupl` file, and choose **Coupl: Run Workflow** or click the play button in the editor title. A trusted workspace is required. The command compiles a snapshot of the current buffer, including unsaved edits, against a freshly fetched server catalog. A saved catalog alone is sufficient for editing, but execution requires the live server. No ComfyUI plugin is needed.

The notification shows queue/node/step progress. **Coupl Runs** in the Output panel records the prompt ID and connection or execution messages. On completion, **Coupl Results** displays downloaded PNG/JPEG/WebP/GIF files, raw node outputs (including text), and Open/Save As buttons. Other file types can be opened or saved. Results are cached under the extension's workspace storage (global storage if no workspace is open); closing the panel does not remove that cache. Result panels disable remote resources and escape node-provided text.

Server validation/runtime errors appear in Problems. If the source changed during execution, a read-only snapshot of the submitted source opens at the failed declaration so the error is not attached to a different version of the code. Each VS Code window monitors one Coupl run at a time.

**Coupl: Stop Monitoring** stops the local wait or downloads; it does **not** interrupt server execution. The default monitoring deadline is 3600 seconds, adjustable with `coupl.runTimeoutSeconds`. Closing VS Code likewise does not stop the server. The prompt ID in the log can be used to find the result in ComfyUI. HTTP history polling continues if WebSocket progress drops; temporary history failures get up to three attempts. An ambiguous submission is never automatically resubmitted.

Bearer tokens from **Coupl: Set ComfyUI Bearer Token** are used for both HTTP requests and WebSocket upgrades. Proxy base paths are supported; redirects are rejected. For a ComfyUI server reached through an SSH tunnel, point `coupl.serverUrl` at the local tunnel endpoint. Models and input assets must already exist on the server. Automatic input uploads, live image previews, and server-side cancellation are not implemented.

## Install locally

From the repository root:

```sh
npm ci
npm run package:extension
code --install-extension dist/coupl-vscode.vsix
```

You can also use **Extensions: Install from VSIX...** and select that file. This project does not currently publish the extension to the Marketplace.

## Develop and test

Open the repository root in VS Code and select **Run Coupl Extension** in Run and Debug, then press F5. The launch configuration builds the compiler, server, and extension first.

```sh
npm run check
npm test
npm run test:extension
```

The last command opens an isolated VS Code window using a temporary profile, synthetic catalog, and test document. It verifies extension activation and language features without changing the normal editor profile. It uses the standard macOS app location or `code` on other systems; set `COUPL_VSCODE_EXECUTABLE` to override the launcher.

The language server can also run independently for other LSP clients:

```sh
node packages/language-server/dist/server.js --stdio
```

Configure the `coupl` section with the same catalog settings. Standalone clients may use `COUPL_BEARER_TOKEN` for authentication. The VS Code extension uses its secret storage instead.

## Current limits

Rename and formatting are not implemented. Completion lists available node references without filtering them by inferred connection type; the compiler validates selected connections. Hover and signatures show declared catalog types, which may include generic matching ports. Recovery is intended to keep nearby editor features working and is not a guarantee of full semantic analysis for malformed source. Compiler diagnostics retain strict parsing and can stop at the first syntax error.

Node metadata does not describe every server-side custom validation rule, so static validation cannot guarantee successful workflow execution.
