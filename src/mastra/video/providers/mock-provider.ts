import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProviderOutput, ProviderTransformInput, VideoTransformationProvider } from '../types.ts';

/**
 * In-process provider used by tests (and available as VIDEO_AI_BACKEND=mock
 * for local dry runs without ComfyUI). Performs no AI inference: it copies
 * the already-extracted source frames through to a "generated" directory
 * unchanged, so the rest of the pipeline (reassembly, audio mux, metadata)
 * can be exercised deterministically and without a GPU/network/ffmpeg model.
 */
export class MockVideoTransformationProvider implements VideoTransformationProvider {
  readonly name = 'mock' as const;

  async transform(input: ProviderTransformInput): Promise<ProviderOutput> {
    const outDir = join(input.workDir, 'mock-provider-output');
    await mkdir(outDir, { recursive: true });
    await cp(input.framesDir, outDir, { recursive: true });
    return { kind: 'frames', dir: outDir, fps: input.fps, pattern: input.framePattern };
  }
}
