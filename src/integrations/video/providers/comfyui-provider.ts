import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  resolveComfyUiBaseUrl,
  resolveComfyUiPollIntervalMs,
  resolveComfyUiTimeoutMs,
  resolveComfyUiWorkflowPath,
} from '../config.ts';
import { VideoTransformError, type ProviderOutput, type ProviderTransformInput, type VideoTransformationProvider } from '../types.ts';

/**
 * Adapter to a locally running ComfyUI instance (treated purely as an
 * inference service - its implementation is not vendored into this repo).
 * Submits a workflow graph loaded from a configurable JSON template file
 * (COMFYUI_WORKFLOW_PATH, see providers/comfyui-workflow.sample.json),
 * polls ComfyUI's HTTP history API until the run completes, and downloads
 * whatever output node produced a video or frame sequence.
 *
 * The sample template is built around ComfyUI-AnimateDiff-Evolved +
 * ControlNet (pose) + IPAdapter (character reference) + VideoHelperSuite
 * (frame load/combine) - a workflow shape that preserves source motion via
 * ControlNet while steering appearance via IPAdapter, per the project's
 * "preserve motion, transform appearance" requirement. Swap
 * COMFYUI_WORKFLOW_PATH to any other ComfyUI graph that accepts the same
 * placeholder tokens to change the underlying model stack without touching
 * this file.
 */
export class ComfyUiVideoTransformationProvider implements VideoTransformationProvider {
  readonly name = 'comfyui' as const;

  async transform(input: ProviderTransformInput): Promise<ProviderOutput> {
    const baseUrl = resolveComfyUiBaseUrl();
    const template = await this.loadWorkflowTemplate();
    const graph = substituteTokens(template, {
      SOURCE_FRAMES_DIR: input.framesDir,
      FRAME_PATTERN: input.framePattern,
      CHARACTER_IMAGE: input.characterReference,
      OUTFIT_IMAGE: input.outfitReference ?? '',
      PROMPT: input.prompt ?? '',
      APPEARANCE_VARIATION: input.appearanceVariation,
      // 'subtle' lowers IPAdapter fidelity to the reference slightly so the
      // diffusion/denoise pass has room to introduce a distinct synthetic
      // look; 'none' keeps conditioning at full strength (closest to the
      // reference image the model stack can produce, never pixel-identical).
      CHARACTER_WEIGHT: input.appearanceVariation === 'subtle' ? '0.75' : '1.0',
      FPS: String(input.fps),
      WIDTH: String(input.width),
      HEIGHT: String(input.height),
      SEED: String(Math.floor(Math.random() * 2 ** 31)),
    });

    const clientId = randomUUID();
    const promptId = await this.submit(baseUrl, graph, clientId);
    const outputs = await this.awaitCompletion(baseUrl, promptId);
    return this.downloadOutput(baseUrl, outputs, input.workDir);
  }

  private async loadWorkflowTemplate(): Promise<unknown> {
    const path = resolveComfyUiWorkflowPath();
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch (err) {
      throw new VideoTransformError('INVALID_CONFIG', `Could not read ComfyUI workflow template at "${path}".`, { cause: err });
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      throw new VideoTransformError('INVALID_CONFIG', `ComfyUI workflow template at "${path}" is not valid JSON.`, { cause: err });
    }
  }

  private async submit(baseUrl: string, graph: unknown, clientId: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: graph, client_id: clientId }),
      });
    } catch (err) {
      throw new VideoTransformError('BACKEND_UNAVAILABLE', `Could not reach ComfyUI at "${baseUrl}". Is it running?`, { cause: err });
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new VideoTransformError('BACKEND_FAILED', `ComfyUI rejected the workflow (HTTP ${response.status}): ${body.slice(0, 500)}`);
    }

    let parsed: { prompt_id?: string; node_errors?: Record<string, unknown> };
    try {
      parsed = await response.json();
    } catch (err) {
      throw new VideoTransformError('MALFORMED_BACKEND_RESPONSE', 'ComfyUI /prompt response was not valid JSON.', { cause: err });
    }

    if (parsed.node_errors && Object.keys(parsed.node_errors).length > 0) {
      throw new VideoTransformError('BACKEND_FAILED', `ComfyUI workflow has node errors: ${JSON.stringify(parsed.node_errors).slice(0, 500)}`);
    }
    if (!parsed.prompt_id) {
      throw new VideoTransformError('MALFORMED_BACKEND_RESPONSE', 'ComfyUI /prompt response did not include a prompt_id.');
    }
    return parsed.prompt_id;
  }

  private async awaitCompletion(baseUrl: string, promptId: string): Promise<Record<string, unknown>> {
    const timeoutMs = resolveComfyUiTimeoutMs();
    const pollIntervalMs = resolveComfyUiPollIntervalMs();
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      let response: Response;
      try {
        response = await fetch(`${baseUrl}/history/${promptId}`);
      } catch (err) {
        throw new VideoTransformError('BACKEND_UNAVAILABLE', `Lost connection to ComfyUI at "${baseUrl}" while waiting for completion.`, { cause: err });
      }

      if (response.ok) {
        let history: Record<string, { status?: { completed?: boolean; status_str?: string }; outputs?: Record<string, unknown> }>;
        try {
          history = await response.json();
        } catch (err) {
          throw new VideoTransformError('MALFORMED_BACKEND_RESPONSE', 'ComfyUI /history response was not valid JSON.', { cause: err });
        }

        const entry = history[promptId];
        if (entry) {
          if (entry.status?.status_str === 'error') {
            throw new VideoTransformError('BACKEND_FAILED', `ComfyUI run ${promptId} failed.`);
          }
          if (entry.status?.completed && entry.outputs) {
            return entry.outputs;
          }
        }
      }

      await sleep(pollIntervalMs);
    }

    throw new VideoTransformError('BACKEND_TIMEOUT', `ComfyUI run ${promptId} did not complete within ${timeoutMs}ms.`);
  }

  private async downloadOutput(baseUrl: string, outputs: Record<string, unknown>, workDir: string): Promise<ProviderOutput> {
    const outDir = join(workDir, 'comfyui-output');
    await mkdir(outDir, { recursive: true });

    for (const nodeOutput of Object.values(outputs)) {
      const gifs = (nodeOutput as { gifs?: ComfyFileRef[] })?.gifs;
      if (gifs && gifs.length > 0) {
        const localPath = join(outDir, 'output.mp4');
        await this.downloadFile(baseUrl, gifs[0], localPath);
        return { kind: 'video', path: localPath };
      }
    }

    for (const nodeOutput of Object.values(outputs)) {
      const images = (nodeOutput as { images?: ComfyFileRef[] })?.images;
      if (images && images.length > 0) {
        for (const [i, ref] of images.entries()) {
          const localPath = join(outDir, `frame-${String(i + 1).padStart(6, '0')}.png`);
          await this.downloadFile(baseUrl, ref, localPath);
        }
        return { kind: 'frames', dir: outDir, fps: 0, pattern: 'frame-%06d.png' };
      }
    }

    throw new VideoTransformError('MALFORMED_BACKEND_RESPONSE', 'ComfyUI run completed but produced no recognizable video or image outputs.');
  }

  private async downloadFile(baseUrl: string, ref: ComfyFileRef, destPath: string): Promise<void> {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type ?? 'output',
    });
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/view?${params.toString()}`);
    } catch (err) {
      throw new VideoTransformError('BACKEND_UNAVAILABLE', `Could not download output "${ref.filename}" from ComfyUI.`, { cause: err });
    }
    if (!response.ok) {
      throw new VideoTransformError('BACKEND_FAILED', `ComfyUI returned HTTP ${response.status} downloading "${ref.filename}".`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(destPath, bytes);
  }
}

interface ComfyFileRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const NUMERIC_TOKEN_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * Deep-walks a parsed JSON value, replacing "{{TOKEN}}" occurrences in string
 * leaves. Exported for tests.
 *
 * A string leaf that is *exactly* one whole "{{TOKEN}}" (nothing else around
 * it) whose value looks numeric (e.g. SEED, FPS, CHARACTER_WEIGHT) is
 * replaced with a real JSON number, not a quoted string - several ComfyUI
 * widgets (KSampler.seed, VHS_VideoCombine.frame_rate, IPAdapter*.weight) are
 * typed INT/FLOAT and reject a numeric string. Partial matches inside a
 * larger string (paths, prompts) always stay string substitution.
 */
export function substituteTokens(value: unknown, tokens: Record<string, string>): unknown {
  if (typeof value === 'string') {
    const wholeMatch = /^\{\{(\w+)\}\}$/.exec(value);
    if (wholeMatch && wholeMatch[1] in tokens) {
      const raw = tokens[wholeMatch[1]];
      if (NUMERIC_TOKEN_PATTERN.test(raw)) {
        return Number(raw);
      }
      return raw;
    }
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in tokens ? tokens[key] : match));
  }
  if (Array.isArray(value)) {
    return value.map((item) => substituteTokens(item, tokens));
  }
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      result[k] = substituteTokens(v, tokens);
    }
    return result;
  }
  return value;
}
