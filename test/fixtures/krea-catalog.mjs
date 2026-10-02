import { catalog, node } from './catalog.mjs';

// Hand-authored /object_info fixture, not a live catalog. Model choices are fixture data.
// V3 encodings checked against ComfyUI comfy_api/latest/_io.py:
// https://github.com/Comfy-Org/ComfyUI/blob/master/comfy_api/latest/_io.py
// Node definitions: comfy_extras/{nodes_textgen,nodes_logic,nodes_preview_any}.py.
export const MATCH = 'COMFY_MATCHTYPE_V3';
export const DYNAMIC = 'COMFY_DYNAMICCOMBO_V3';
export function matchInput(id = 'switch', allowed = '*') {
  return [MATCH, { template: { template_id: id, allowed_types: allowed } }];
}
export function switchNode(allowed = '*') {
  return {
    ...node({ switch: ['BOOLEAN'] }, [MATCH], {
      optional: { on_false: matchInput('switch', allowed), on_true: matchInput('switch', allowed) },
      names: ['output'],
    }),
    output_matchtypes: ['switch'],
  };
}
export function kreaCatalog() {
  const definitions = catalog();
  definitions.KSampler.input.required.scheduler[0] = ['normal', 'simple'];
  return {
    ...definitions,
    UNETLoader: node({ unet_name: [['krea2_turbo_fp8_scaled.safetensors']], weight_dtype: [['default']] }, ['MODEL']),
    CLIPLoader: node({ clip_name: [['qwen3vl_4b_fp8_scaled.safetensors']], type: [['krea2']] }, ['CLIP'], { optional: { device: [['default']] } }),
    VAELoader: node({ vae_name: [['qwen_image_vae.safetensors']] }, ['VAE']),
    LoraLoaderModelOnly: node({ model: ['MODEL'], lora_name: [['krea2_darkbrush.safetensors']], strength_model: ['FLOAT', { min: -100, max: 100 }] }, ['MODEL']),
    PrimitiveStringMultiline: node({ value: ['STRING'] }, ['STRING']),
    PrimitiveBoolean: node({ value: ['BOOLEAN'] }, ['BOOLEAN']),
    StringConcatenate: node({ string_a: ['STRING'], string_b: ['STRING'], delimiter: ['STRING'] }, ['STRING']),
    PreviewAny: node({ source: ['*'] }, ['STRING'], { outputNode: true }),
    ConditioningZeroOut: node({ conditioning: ['CONDITIONING'] }, ['CONDITIONING']),
    ComfySwitchNode: switchNode(),
    TextGenerate: node({
      clip: ['CLIP'], prompt: ['STRING'], max_length: ['INT', { min: 1, max: 32768 }],
      sampling_mode: [DYNAMIC, { options: [
        { key: 'on', inputs: {
          required: {
            temperature: ['FLOAT', { min: 0.01, max: 2 }],
            top_k: ['INT', { min: 0, max: 1000 }], top_p: ['FLOAT', { min: 0, max: 1 }],
            min_p: ['FLOAT', { min: 0, max: 1 }], repetition_penalty: ['FLOAT', { min: 0, max: 5 }],
            seed: ['INT', { min: 0, max: 18446744073709551615 }],
          },
          optional: { presence_penalty: ['FLOAT', { min: 0, max: 5 }] },
        } },
        { key: 'off', inputs: { required: {} } },
      ] }],
    }, ['STRING', 'STRING'], {
      names: ['generated_text', 'thinking'], optional: {
        image: ['IMAGE'], video: ['IMAGE'], audio: ['AUDIO'], thinking: ['BOOLEAN'],
        use_default_template: ['BOOLEAN'], mtp: [['auto', 'off', '2', '3', '4', '5']], system_prompt: ['STRING'],
      },
    }),
  };
}
