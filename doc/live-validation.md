# First live validation

Date: September 24, 2026 (America/Los_Angeles).
Server: ComfyUI 0.37.0, accessed at `http://127.0.0.1:8188`.

## Catalog and compilation

The live `/object_info` catalog contained 962 node classes. The CLI retrieved the catalog successfully. `CLIPTextEncode` advertised positional order `text`, then `clip`, matching the language example.

The text-to-image example failed with `E_ENUM` at line 3, column 37 because `CheckpointLoaderSimple` advertised an empty checkpoint list. This confirms instance-specific enum checking; it does not imply that the instance has no models available through other loaders. The generic example and its synthetic fixture were left unchanged.

The model-free graph compiled successfully:

```sh
node dist/cli.js compile examples/blank-image.coupl \
  --server http://127.0.0.1:8188 \
  --output /private/tmp/coupl-live-blank-image.json
```

It uses two nodes, `image = EmptyImage(...)` and `preview = PreviewImage(image.IMAGE)`. Compilation preserved those names as API IDs and lowered the connection to `["image", 0]`.

## Server acceptance and execution

The queue was empty before the test. The compiled graph was manually wrapped in `{"prompt": <graph>}` and submitted once to `POST /prompt`, separately from the CLI.

- HTTP status: 200.
- Prompt ID: `0b6adf59-3a2b-4611-9300-9dc0fe9571bc`.
- `node_errors`: `{}`.
- History: `status_str = "success"`, `completed = true`, with an `execution_success` event.
- The `preview` output contained one temporary PNG. Fetching it through `/view` confirmed the PNG signature and 64×64 dimensions.

This establishes that the live catalog can drive compilation and that this graph's named IDs, positional/named bindings, output reference, and emitted JSON are accepted and executable by ComfyUI. No compiler changes were needed for the check.

## Limits

The test created a small constant-color image. It did not load a model, run diffusion, or validate every schema in the catalog. The text-to-image graph still needs a compatible checkpoint or a separate example using the instance's available model loaders. Browser runtime behavior remains untested. The CLI continues to compile only; no submission or execution command was added.

The complete live catalog and downloaded preview were kept outside the repository. Automated tests continue to use synthetic metadata.
