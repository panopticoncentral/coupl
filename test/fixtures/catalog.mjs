// A hand-authored, deliberately small /object_info fixture, not a live snapshot.
// Port names/order follow ComfyUI nodes.py; model and sampler choices are synthetic.
export function node(required, output, options = {}) {
  const { optional = {}, hidden = {}, names = output, outputNode = false } = options;
  return {
    input: { required, optional, hidden },
    input_order: { required: Object.keys(required), optional: Object.keys(optional), hidden: Object.keys(hidden) },
    output,
    output_name: names,
    output_node: outputNode,
  };
}

export function catalog() {
  return {
    CheckpointLoaderSimple: node({ ckpt_name: [["example.safetensors"]] }, ["MODEL", "CLIP", "VAE"]),
    CLIPTextEncode: node({ text: ["STRING", { multiline: true }], clip: ["CLIP"] }, ["CONDITIONING"]),
    EmptyLatentImage: node({
      width: ["INT", { min: 16, max: 16384 }], height: ["INT", { min: 16, max: 16384 }], batch_size: ["INT", { min: 1, max: 4096 }],
    }, ["LATENT"]),
    KSampler: node({
      model: ["MODEL"], seed: ["INT", { min: 0, max: 18446744073709551615 }], steps: ["INT", { min: 1, max: 10000 }],
      cfg: ["FLOAT", { min: 0, max: 100 }], sampler_name: [["euler"]], scheduler: [["normal"]],
      positive: ["CONDITIONING"], negative: ["CONDITIONING"], latent_image: ["LATENT"], denoise: ["FLOAT", { min: 0, max: 1 }],
    }, ["LATENT"]),
    VAEDecode: node({ samples: ["LATENT"], vae: ["VAE"] }, ["IMAGE"]),
    SaveImage: node({ images: ["IMAGE"], filename_prefix: ["STRING", { default: "ComfyUI" }] }, [], { outputNode: true }),
  };
}
