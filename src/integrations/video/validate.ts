import { stat, statfs } from 'node:fs/promises';
import { extname } from 'node:path';
import { checkFfmpegAvailable } from './ffmpeg.ts';
import { resolveMinFreeDiskBytes } from './config.ts';
import { VideoTransformError, type VideoTransformationInput } from './types.ts';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.m4v', '.webm', '.avi', '.mkv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);

async function requireFile(path: string, code: 'SOURCE_VIDEO_MISSING' | 'CHARACTER_IMAGE_MISSING' | 'OUTFIT_IMAGE_MISSING', label: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new VideoTransformError(code, `${label} not found: "${path}"`);
  }
  if (!info.isFile()) {
    throw new VideoTransformError(code, `${label} is not a regular file: "${path}"`);
  }
}

function requireExtension(path: string, allowed: Set<string>, code: 'INVALID_VIDEO_FORMAT' | 'INVALID_IMAGE_FORMAT', label: string): void {
  const ext = extname(path).toLowerCase();
  if (!allowed.has(ext)) {
    throw new VideoTransformError(
      code,
      `${label} "${path}" has unsupported extension "${ext || '(none)'}". Supported: ${[...allowed].join(', ')}.`,
    );
  }
}

/** Best-effort: some filesystems/platforms don't implement statfs; a check that can't run is skipped rather than failing the pipeline. */
async function checkDiskSpace(path: string): Promise<void> {
  const minFreeBytes = resolveMinFreeDiskBytes();
  try {
    const info = await statfs(path);
    const freeBytes = info.bavail * info.bsize;
    if (freeBytes < minFreeBytes) {
      throw new VideoTransformError(
        'INSUFFICIENT_DISK_SPACE',
        `Only ${Math.round(freeBytes / 1024 / 1024)}MB free near "${path}", need at least ${Math.round(minFreeBytes / 1024 / 1024)}MB.`,
      );
    }
  } catch (err) {
    if (err instanceof VideoTransformError) throw err;
    // statfs unsupported/failed for a reason unrelated to disk space - skip the check.
  }
}

export async function validateInput(input: VideoTransformationInput): Promise<void> {
  await requireFile(input.sourceVideo, 'SOURCE_VIDEO_MISSING', 'Source video');
  requireExtension(input.sourceVideo, VIDEO_EXTENSIONS, 'INVALID_VIDEO_FORMAT', 'Source video');

  await requireFile(input.characterReference, 'CHARACTER_IMAGE_MISSING', 'Character reference image');
  requireExtension(input.characterReference, IMAGE_EXTENSIONS, 'INVALID_IMAGE_FORMAT', 'Character reference image');

  if (input.outfitReference) {
    await requireFile(input.outfitReference, 'OUTFIT_IMAGE_MISSING', 'Outfit reference image');
    requireExtension(input.outfitReference, IMAGE_EXTENSIONS, 'INVALID_IMAGE_FORMAT', 'Outfit reference image');
  }

  if (!input.outputPath || input.outputPath.trim() === '') {
    throw new VideoTransformError('INVALID_CONFIG', 'outputPath is required.');
  }
  if (extname(input.outputPath).toLowerCase() !== '.mp4') {
    throw new VideoTransformError('INVALID_CONFIG', `outputPath "${input.outputPath}" must end in .mp4.`);
  }

  await checkFfmpegAvailable();
  await checkDiskSpace(input.sourceVideo);
}
