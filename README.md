# Coupl

Coupl is a project to create a domain-specific language for describing [ComfyUI](https://github.com/comfyanonymous/ComfyUI) workflows. The aim is to make workflow definitions more natural to read and write than raw ComfyUI API JSON or pseudo-Python.

The compiler, Node.js CLI, and VS Code extension support compiling and executing workflows against a ComfyUI server. The language is small and experimental; validation covers a documented subset of ComfyUI node metadata.

## Direction

- Implement Coupl in TypeScript, with a compiler that can eventually run in the browser.
- Focus first on a Node.js CLI.
- Define a DSL for specifying a ComfyUI graph and compile it to ComfyUI API JSON.
- Have the CLI accept a DSL file and a target ComfyUI instance.
- Check the graph's nodes against the definitions available on that instance, including installed custom nodes.

## Language direction

Name nodes with top-level assignments and construct them with function-call syntax:

```text
checkpoint = CheckpointLoaderSimple("example.safetensors")
positive = CLIPTextEncode("A small observatory above a sea of clouds", clip = checkpoint.CLIP)
```

Calls accept positional inputs and named inputs using `name = value`. Once a named input appears, all following inputs must be named. Both forms compile to named inputs in ComfyUI API JSON.

## Run the CLI

Requires Node.js 22 or newer.

```sh
npm ci
npm run build
node dist/cli.js compile examples/blank-image.coupl --server http://localhost:8188 --output graph.json
```

The [blank-image example](examples/blank-image.coupl) needs no models: it describes a 64×64 image and a preview. For the full [text-to-image example](examples/text-to-image.coupl), replace `example.safetensors` with a compatible checkpoint installed on your instance.

The `compile` command fetches `/object_info` once, checks the graph, and writes API JSON. It does not submit a prompt or start execution. Omit `--output` to write JSON to stdout; diagnostics go to stderr and errors return a nonzero exit code. An existing output file is replaced only after compilation succeeds, using a temporary file in the same directory. The source file cannot be used as the output file.

Reverse-proxy base paths are supported, such as `https://example.test/comfy`. Set `COUPL_BEARER_TOKEN` in the environment if the server requires bearer authentication; `.env` files are not automatically loaded. Requests time out after 15 seconds and do not follow redirects. Use the instance's direct base URL.

## Execute a workflow

```sh
node dist/cli.js run examples/blank-image.coupl --server http://localhost:8188 --output-dir ./run-results
```

`run` fetches the current server catalog, compiles the source, submits the API graph once, and waits for completion. It prints result JSON (prompt ID, node outputs, and file references) to stdout and progress to stderr. `--output-dir` creates a **new** directory containing `result.json` and downloaded files with numbered, sanitized names. Existing directories are rejected before submission. Omit it to retrieve metadata without downloading files. Local image paths are not uploaded automatically; input files and models must already exist on the server.

Use `--timeout <seconds>` to change the default one-hour monitoring deadline, including queue time. Ctrl-C stops monitoring; the queued/running workflow may continue on ComfyUI. The CLI never uses the server-wide interrupt endpoint. If a submission response is lost, acceptance is unknown: inspect ComfyUI's queue/history before retrying. Submissions are never retried automatically.

HTTP and WebSocket connections preserve reverse-proxy base paths and use `COUPL_BEARER_TOKEN` when provided. Redirects are rejected. WebSocket events supply node/step progress; history polling retrieves the final outputs even when progress is unavailable or disconnects. Transient history failures are retried up to three attempts. This is execution monitoring, not automatic reconnection to the progress socket. Runtime errors include source node locations. A server can accept a subset of output branches; any returned node validation warnings are reported.

In VS Code, configure `coupl.serverUrl` and choose **Coupl: Run Workflow** or the editor's play button. See the [extension guide](packages/vscode/README.md#run-workflows) for results and monitoring controls.

The shared client can also be used directly:

```ts
import { compile, fetchNodeCatalog } from "coupl";
import { createComfyClient } from "coupl/node";

const server = "http://localhost:8188";
const compiled = compile(sourceText, await fetchNodeCatalog(server));
if (!compiled.ok) throw new Error("Fix the compilation diagnostics first.");
const client = createComfyClient(server);
const result = await client.run(compiled.graph, { onEvent: event => console.error(event) });
// result.promptId, result.outputs, result.files
// await client.download(result.files[0]) -> Uint8Array
// await client.wait(knownPromptId) resumes history monitoring without resubmission.
```

The `ComfyClient` export from `coupl` uses HTTP polling by default and accepts an optional `progressTransport`; it has no Node dependencies. `createComfyClient` from `coupl/node` supplies the Node WebSocket transport. Client options accept headers, request timeout, and an abort signal; run options accept monitoring timeout, polling interval, abort signal, and progress callback. Aborting does not cancel remote work.

## Supported language

See the [Coupl language specification](doc/language-specification.md) for the complete grammar, binding and type rules, catalog contract, and graph emission semantics.

- Top-level node calls and boolean/string literal assignments, comma-separated arguments, multiline calls, trailing commas, and `//` comments.
- Map arguments for dynamic-choice inputs, using `{ key = value, ... }` with optional nested maps.
- Positional arguments in `input_order`: required inputs, then optional inputs. Hidden inputs are excluded. Missing or malformed order metadata requires named arguments.
- Strings with JSON escapes or raw triple-quoted strings, numbers, booleans, and output references: bare `node` for a single output, or `node.OUTPUT`, `node[0]`, and `node["output name"]` for explicit selection.
- Exact, case-sensitive class and port names, with quoted class/input names when needed: `x = "Vendor: Node"("input name" = 1)`.
- Forward references and multiple independent branches. Duplicate nodes/inputs, missing arguments, bad connections, and dependency cycles produce source-located errors.

Required inputs must be supplied even if the UI advertises defaults. Optional inputs may be omitted. Integers outside JavaScript's safe range (±9,007,199,254,740,991), non-finite values, and numbers that underflow to zero are rejected. Ordinary decimal values use JavaScript floating-point precision. Expressions, general constants, numeric literal assignments, imports, nested calls, literal arrays, standalone map assignments, arbitrary dictionary-valued inputs, and reusable subgraphs are not implemented.

Top-level literals are shorthand for primitive nodes:

```text
enable_lora = false                       // PrimitiveBoolean(value = false)
label = "Krea"                            // PrimitiveString(value = "Krea")
prompt = """A small observatory.
Warm light through the windows."""       // PrimitiveStringMultiline(value = ...)
```

The quote syntax chooses the string node class; even a regular string with an escaped newline uses `PrimitiveString`. These assignments create named nodes with a single output, so connections can use `enable_lora` or `prompt` directly. Explicit selectors such as `enable_lora[0]` and `prompt.STRING` remain valid. Literals inside calls stay inline: `sampling_mode = "on"` remains an enum value, not a connection. The generated primitive class must exist in the target catalog and its inputs undergo the same validation as an explicit call. Numbers still require an explicit `PrimitiveInt` or `PrimitiveFloat` call when a named node is wanted.

Triple-quoted strings make long prompts readable:

```text
prompt = PrimitiveStringMultiline(value = """A small observatory above the clouds.
Warm light through the windows, a sign reading "Welcome".""")
```

Everything between the delimiters is literal, including newlines, indentation, backslashes, and `//`. There is no automatic trimming or escape processing. A closing run of four or five quotes preserves one or two trailing quotes in the value. Use a regular JSON-escaped string if the text contains three consecutive quotes. Triple quotes are for values; class, input, and output names still use ordinary quotes.

A bare node name selects its only output when the target catalog declares exactly one. Nodes with multiple outputs require an explicit selector, even if only one output has the expected type; nodes with no outputs cannot be used as inputs. Forward references, type checking, and cycle detection apply equally to both forms.

Dynamic-choice inputs can group their settings in a map:

```text
refined_prompt = TextGenerate(
  clip = clip,
  prompt = refinement_input,
  max_length = 512,
  sampling_mode = {
    sampling_mode = "on",
    temperature = 0.7,
    top_k = 64,
    top_p = 0.95,
    min_p = 0.05,
    repetition_penalty = 1.05,
    seed = 0,
    presence_penalty = 0,
  },
)
```

The inner `sampling_mode` field selects the option; the remaining fields are its child inputs. The compiler lowers this to the same flat API inputs as `sampling_mode = "on"` plus `"sampling_mode.temperature" = 0.7`, etc. Nested choices use nested maps with their own selector field. Maps accept identifier or quoted keys, existing literals and node references, comments, and trailing commas. They do not create primitive nodes. Duplicate keys, duplicate flattened inputs, unknown/inactive fields, and missing required fields are errors. The selector must be a literal. Dotted and map forms can be combined for distinct inputs, but cannot supply the same input twice. Map syntax is currently supported only for dynamic-choice inputs, with at most 32 nested maps.

The [Krea-2 Turbo example](examples/krea-2-turbo.coupl) preserves the supplied 20-node API graph, including optional prompt refinement and LoRA switches. Sampling settings use a map; the explicit `refined_prompt.generated_text` selector works with both one- and two-output TextGenerate catalogs. It compiles against a source-derived test catalog and matches the original graph after renaming node IDs. Its user prompt is empty and its only execution output is a text preview; uncomment the final `SaveImage` call to add an image output. Live compilation and image generation for this example remain unverified.

## Architecture and validation

The compiler receives source text and node definitions and returns API JSON or diagnostics. It has no filesystem, network, or Node.js dependencies. The CLI handles arguments and files; a separate HTTP client uses standard Fetch APIs. The compiler and HTTP client use browser APIs; the Node execution transport uses `ws` for authenticated WebSocket progress.

The pipeline parses the DSL, resolves graph references, binds arguments, validates against the instance's node definitions, and emits API JSON. Node names become API node IDs. Diagnostics include source spans and, where relevant, the referenced declaration.

ComfyUI exposes node definitions through [`GET /object_info`](https://docs.comfy.org/development/comfyui-server/comms_routes). These provide the basis for checking node classes, required inputs, literal values, and connections. Validation must account for the limits of the metadata: custom nodes can define [server-side validation](https://docs.comfy.org/custom-nodes/backend/server_overview#validate-inputs) that the compiler cannot reproduce from node definitions alone.

The schema subset supports fixed required/optional inputs; `INT`, `FLOAT`, `STRING`, and `BOOLEAN` literals; literal enum choices; advertised numeric bounds; and connections whose fixed type names match exactly. Custom type names are treated as opaque names. Both V1 enum lists and `COMBO` schemas with primitive `options` are supported. It also supports:

- **Dynamic choices:** `COMFY_DYNAMICCOMBO_V3` selects conditional inputs from a literal selector, including nested choices. Supply a map with a selector field and named children, or use quoted, dot-separated API names such as `"sampling_mode.temperature" = 0.7`. Positional arguments continue to use the top-level `input_order`; children are named only. Inactive children are rejected and active required children must be explicit.
- **Wildcards:** `*` accepts any supported literal or connected port. A wildcard output carries unknown type information, so compatibility with a fixed consumer cannot be proven statically.
- **Matching ports:** `COMFY_MATCHTYPE_V3` templates and `output_matchtypes` link the types of a node's inputs and outputs. Constraints propagate across connected nodes and forward references. Conflicting branch types or consumers are errors; each node instance has independent templates. Template `allowed_types` restrictions are checked. These are static constraints on all supplied branches, regardless of a switch's runtime selection.

General union ports, autogrow/dynamic-slot schemas, and connections into enum or dynamic-selector inputs are not supported. Dynamic nesting is bounded to 32 levels. Unusable schemas on referenced classes are errors; unrelated classes do not block compilation. Matching metadata does not guarantee server acceptance or successful execution.

## Library use

```ts
import { compile, fetchNodeCatalog } from "./dist/index.js";

const catalog = await fetchNodeCatalog("http://localhost:8188");
const result = compile(sourceText, catalog);

if (result.ok) {
  const json = JSON.stringify(result.graph, null, 2);
  // Send the JSON to your chosen destination.
} else {
  // Show result.diagnostics, including line/column spans.
}
```

`compile` is synchronous and returns no partial graph on failure. Successful results can include warnings, such as a graph with no execution output node. `parse` and `formatDiagnostic` are also exported. Parsed literal declarations retain their `value` and source span; the compiler lowers them to node calls before catalog validation. The HTTP helper accepts optional headers, an abort signal, and a timeout. A browser client would need appropriate CORS and authentication configuration on its ComfyUI instance.

## Development and verification

### VS Code and language server

This repository also contains the `@coupl/language-server` and `coupl-vscode` workspace packages. They share the compiler core and provide `.coupl` highlighting, live diagnostics, catalog-aware completion, hover, signature help, and go-to-definition.

Run `npm run package:extension` to build `dist/coupl-vscode.vsix`, then install it with VS Code's **Extensions: Install from VSIX...** command. Configure `coupl.serverUrl` for a live ComfyUI instance or `coupl.catalogPath` for a saved `/object_info` JSON catalog. See the [extension guide](packages/vscode/README.md) for authentication, offline behavior, F5 debugging, and standalone LSP setup.

`npm run test:extension` runs an editor smoke test in an isolated VS Code window. The ordinary test suite includes language-feature, bundled-server protocol, and HTTP/WebSocket execution tests. Execution tests cover authentication, early events, connection failures, runtime errors, downloads, deadlines, and avoiding duplicate submissions. The core remains browser-compatible; editor and protocol dependencies live in the workspace packages.

### Compiler and workspace checks

```sh
npm run check
npm test
```

`check` type-checks the project and checks the core separately with browser APIs and no Node types. Tests compare the complete basic example against independently authored expected JSON and the Krea example against its original API JSON. They exercise conditional schemas, type propagation, multiline strings, literal assignment lowering, implicit single-output references, dynamic-map lowering, compiler errors and argument equivalence, and run the CLI against temporary localhost HTTP servers. Catalog fixtures are hand-authored; the Krea fixture follows ComfyUI's published schema encoding and is not a live instance snapshot.

The [first live validation](doc/live-validation.md) passed against ComfyUI 0.37.0: the CLI compiled the blank-image example from the live catalog, and a separate manual API submission completed successfully and returned a 64×64 PNG. The text-to-image example correctly failed compilation because that instance reported no checkpoints. Diffusion generation and browser runtime behavior remain unverified.

## Language reference and future work

See the [language specification](doc/language-specification.md) for the grammar, binding rules, and worked example. The [example API JSON](examples/text-to-image.api.json) is the compiler's expected output fixture.

Future scope includes richer schema support, language conveniences such as constants and reusable subgraphs, input asset uploads, live image previews, and server-side cancellation.

## License

Coupl is licensed under the [MIT License](LICENSE).
