import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * TEMPORARY STUB entrypoint for the AI Affiliate Video Generator's new
 * "target product images -> video" flow.
 *
 * This exists ONLY so the job-creation / polling / UI plumbing built in
 * eshop's admin workspace (src/modules/workspace) can be exercised
 * end-to-end without waiting on the real generation pipeline. It stitches
 * the uploaded product images into a plain slideshow clip with ffmpeg -
 * fixed camera, no AI, no product-fidelity guarantee.
 *
 * It does NOT run the ComfyUI product-fidelity pipeline validated
 * separately under
 *   .workdir/quick-video/scratchpad/comfy-affiliate-v1
 * (img2img-from-real-photo + depth-ControlNet + IPAdapter for stills,
 * AnimateDiff for the short video test). Wiring that recipe in here -
 * reading --images/--sample-video/--prompt below and driving the comfy CLI
 * against the approved recipe - is the one remaining step to make this a
 * real product-fidelity video generator.
 *
 * CLI contract mirrors scripts/video-transform.ts so the calling code
 * (eshop's runAffiliateVideoPipeline.js) can reuse the same
 * spawn/parse-last-json-line pattern:
 *
 *   node --env-file=.env scripts/affiliate-video-generate.ts \
 *     --images img1.jpg,img2.jpg[,img3.jpg,img4.jpg] \
 *     --output ./output/result.mp4 \
 *     [--sample-video ref.mp4] [--prompt "..."] [--json]
 */

const FLAGS = new Set(['--images', '--output', '--sample-video', '--prompt']);
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
  return 'Usage: node scripts/affiliate-video-generate.ts --images <path,path,...> --output <path> [--sample-video <path>] [--prompt <text>] [--json]';
}

const SECONDS_PER_IMAGE = 2;

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

  if (!flags.images || !flags.output) {
    const message = 'Missing required flag(s). --images and --output are required.';
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, code: 'MISSING_FLAGS', message }));
    } else {
      console.error(message);
      console.error(usage());
    }
    process.exitCode = 1;
    return;
  }

  const imagePaths = (flags.images as string).split(',').map((p) => p.trim()).filter(Boolean);
  const outputPath = flags.output as string;

  if (imagePaths.length < 2 || imagePaths.length > 4) {
    const message = `Expected 2-4 image paths, got ${imagePaths.length}.`;
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, code: 'INVALID_IMAGE_COUNT', message }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  for (const p of imagePaths) {
    if (!existsSync(p)) {
      const message = `Image not found: ${p}`;
      if (jsonOutput) {
        console.log(JSON.stringify({ ok: false, code: 'IMAGE_NOT_FOUND', message }));
      } else {
        console.error(message);
      }
      process.exitCode = 1;
      return;
    }
  }

  mkdirSync(dirname(outputPath), { recursive: true });

  // Simple ffmpeg slideshow: each image held for SECONDS_PER_IMAGE, no
  // audio, no camera motion, no AI - a placeholder clip only.
  const concatArgs: string[] = [];
  imagePaths.forEach((p) => {
    concatArgs.push('-loop', '1', '-t', String(SECONDS_PER_IMAGE), '-i', p);
  });
  const filterInputs = imagePaths.map((_, i) => `[${i}:v]scale=768:1024:force_original_aspect_ratio=decrease,pad=768:1024:(ow-iw)/2:(oh-ih)/2,setsar=1[v${i}]`).join(';');
  const concatInputs = imagePaths.map((_, i) => `[v${i}]`).join('');
  const filterComplex = `${filterInputs};${concatInputs}concat=n=${imagePaths.length}:v=1:a=0[outv]`;

  const ffmpegResult = spawnSync('ffmpeg', [
    '-y',
    ...concatArgs,
    '-filter_complex', filterComplex,
    '-map', '[outv]',
    '-r', '24',
    '-pix_fmt', 'yuv420p',
    outputPath
  ], { encoding: 'utf-8' });

  if (ffmpegResult.status !== 0) {
    const message = `ffmpeg failed: ${ffmpegResult.stderr?.slice(-500) || 'unknown error'}`;
    if (jsonOutput) {
      console.log(JSON.stringify({ ok: false, code: 'FFMPEG_FAILED', message }));
    } else {
      console.error(message);
    }
    process.exitCode = 1;
    return;
  }

  const metadata = {
    backend: 'stub-ffmpeg-slideshow',
    outputWidth: 768,
    outputHeight: 1024,
    outputFps: 24,
    frameCount: imagePaths.length * SECONDS_PER_IMAGE * 24,
    imageCount: imagePaths.length,
    hasSampleVideo: Boolean(flags['sample-video']),
    prompt: (flags.prompt as string) || null
  };

  if (jsonOutput) {
    console.log(JSON.stringify({ ok: true, outputPath, metadata }));
    return;
  }
  console.log('\nDone (stub).');
  console.log(`  output: ${outputPath}`);
  console.log('  NOTE: this is a placeholder slideshow, not a real AI-generated video.');
}

await main();
