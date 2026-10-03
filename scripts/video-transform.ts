import { runVideoTransformationPipeline } from '../src/mastra/video/pipeline.ts';
import type { AppearanceVariation, VideoTransformationInput } from '../src/mastra/video/types.ts';
import { VideoTransformError } from '../src/mastra/video/types.ts';

/**
 * Developer CLI for the local video transformation pipeline.
 *
 *   npm run video:transform -- \
 *     --video ./input/source.mp4 \
 *     --character ./input/character.jpg \
 *     --outfit ./input/outfit.jpg \
 *     --output ./output/result.mp4
 *
 * Hand-rolled flag parsing (no CLI framework dependency) - this is a small,
 * fixed set of flags, not worth a new dependency for.
 */

const FLAGS = new Set([
  '--video',
  '--character',
  '--outfit',
  '--output',
  '--prompt',
  '--appearance-variation',
  '--fps',
  '--max-dimension',
]);

const BOOLEAN_FLAGS = new Set(['--json']);

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (BOOLEAN_FLAGS.has(flag)) {
      result[flag.slice(2)] = true;
      continue;
    }
    if (!FLAGS.has(flag)) {
      throw new Error(`Unknown flag "${flag}". Supported: ${[...FLAGS, ...BOOLEAN_FLAGS].join(', ')}`);
    }
    const value = argv[i + 1];
    if (value === undefined || FLAGS.has(value) || BOOLEAN_FLAGS.has(value)) {
      throw new Error(`Flag "${flag}" requires a value.`);
    }
    result[flag.slice(2)] = value;
    i++;
  }
  return result;
}

function usage(): string {
  return [
    'Usage: npm run video:transform -- --video <path> --character <path> [--outfit <path>] --output <path> [--prompt <text>] [--appearance-variation none|subtle] [--fps <n>] [--max-dimension <n>] [--json]',
  ].join('\n');
}

async function main(): Promise<void> {
  let flags: Record<string, string | boolean>;
  try {
    flags = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error((err as Error).message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  const jsonOutput = flags.json === true;

  if (!flags.video || !flags.character || !flags.output) {
    console.error('Missing required flag(s). --video, --character, and --output are required.');
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (flags['appearance-variation'] && flags['appearance-variation'] !== 'none' && flags['appearance-variation'] !== 'subtle') {
    console.error(`--appearance-variation must be "none" or "subtle", got "${flags['appearance-variation']}".`);
    process.exitCode = 1;
    return;
  }

  const input: VideoTransformationInput = {
    sourceVideo: flags.video as string,
    characterReference: flags.character as string,
    outfitReference: flags.outfit as string | undefined,
    outputPath: flags.output as string,
    prompt: flags.prompt as string | undefined,
    appearanceVariation: flags['appearance-variation'] as AppearanceVariation | undefined,
    targetFps: flags.fps ? Number(flags.fps) : undefined,
    maxDimension: flags['max-dimension'] ? Number(flags['max-dimension']) : undefined,
  };

  try {
    const result = await runVideoTransformationPipeline(input);
    if (jsonOutput) {
      // A single trailing JSON line a calling process (e.g. an admin UI's
      // backend) can parse deterministically, regardless of the human-
      // readable `logStage` lines already written to stdout above it.
      console.log(JSON.stringify({ ok: true, outputPath: result.outputPath, metadata: result.metadata }));
      return;
    }
    console.log('\nDone.');
    console.log(`  output: ${result.outputPath}`);
    console.log(`  backend: ${result.metadata.backend}`);
    console.log(`  frames: ${result.metadata.frameCount}`);
    console.log(`  source: ${result.metadata.sourceWidth}x${result.metadata.sourceHeight} @ ${result.metadata.sourceFps.toFixed(2)}fps, ${result.metadata.sourceDurationSeconds.toFixed(1)}s`);
    console.log(`  output: ${result.metadata.outputWidth}x${result.metadata.outputHeight} @ ${result.metadata.outputFps.toFixed(2)}fps`);
    console.log(`  appearanceVariation: ${result.metadata.appearanceVariation}`);
    console.log(`  durationMs: ${result.metadata.durationMs}`);
  } catch (err) {
    if (jsonOutput) {
      const code = err instanceof VideoTransformError ? err.code : 'UNKNOWN';
      const message = err instanceof Error ? err.message : String(err);
      console.log(JSON.stringify({ ok: false, code, message }));
      process.exitCode = 1;
      return;
    }
    if (err instanceof VideoTransformError) {
      console.error(`\n[video-transform] failed (${err.code}): ${err.message}`);
    } else {
      console.error('\n[video-transform] failed with an unexpected error:', err);
    }
    process.exitCode = 1;
  }
}

await main();
