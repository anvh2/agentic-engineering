// Standalone Phase 2 utility. No production imports, database, HTTP, or model calls.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const sharp = require(resolve(root, '../eshop/node_modules/sharp'));

function usage() {
  return 'Usage: node benchmarks/phase2/build.mjs --reference <reference.json> --output <directory> <image1> <image2> [image3] [image4]';
}

function fail(message) { throw new Error(`${message}\n\n${usage()}`); }

function parseArgs(argv) {
  const options = { images: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--reference' || value === '--output') {
      const next = argv[index + 1];
      if (!next || next.startsWith('--')) fail(`${value} needs a value.`);
      options[value.slice(2)] = next;
      index += 1;
    } else if (value.startsWith('--')) {
      fail(`Unknown option: ${value}`);
    } else {
      options.images.push(value);
    }
  }
  if (!options.reference || !options.output) fail('--reference and --output are required.');
  if (options.images.length < 2 || options.images.length > 4) fail(`Expected 2–4 input images; received ${options.images.length}.`);
  return options;
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function roleFor(path) {
  const filename = basename(path).toLowerCase();
  return filename.includes('detail') || filename.includes('close') ? 'construction-detail' : 'overview';
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function xmlText(value) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function runFfmpeg(output, label, args, metrics) {
  const began = performance.now();
  let result = spawnSync('/usr/bin/time', ['-l', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], {
    encoding: 'utf8', timeout: 180000, maxBuffer: 1_000_000,
  });
  // Sandboxed macOS sessions may deny /usr/bin/time access to kern.clockrate.
  // Timing still matters more than a missing RSS sample, so rerun FFmpeg once
  // without the counter only for that known counter-permission failure.
  const counterDenied = /sysctl kern\.clockrate: Operation not permitted/.test(result.stderr || '');
  if (result.status !== 0 && counterDenied) {
    result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], {
      encoding: 'utf8', timeout: 180000, maxBuffer: 1_000_000,
    });
  }
  writeFileSync(resolve(output, `${label}.log`), result.stderr || '');
  const rss = (result.stderr || '').match(/(\d+)\s+maximum resident set size/);
  metrics.steps.push({ label, durationSeconds: (performance.now() - began) / 1000, maxRssBytes: rss ? Number(rss[1]) : null, resourceCounterAvailable: !counterDenied, exitCode: result.status });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.error?.message || result.stderr}`);
}

async function buildReferenceAssets(output, images) {
  const assets = [];
  for (const [index, path] of images.entries()) {
    const metadata = await sharp(path, { animated: false }).metadata();
    if (!metadata.width || !metadata.height) throw new Error(`Could not decode dimensions: ${path}`);
    const preview = `reference-${String(index + 1).padStart(2, '0')}.jpg`;
    await sharp(path).rotate().resize({ width: 720, height: 960, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 92 }).toFile(resolve(output, preview));
    assets.push({ id: `source-${index + 1}`, originalPath: path, originalFilename: basename(path), role: roleFor(path), sha256: sha256(path), mime: metadata.format ? `image/${metadata.format}` : 'unknown', width: metadata.width, height: metadata.height, orientation: metadata.orientation || 1, rendererPreview: preview });
  }
  const board = sharp({ create: { width: 1080, height: 1440, channels: 3, background: '#f5f1e9' } });
  const composites = await Promise.all(assets.map(async (asset, index) => ({
    input: await sharp(resolve(output, asset.rendererPreview)).resize({ width: 328, height: 600, fit: 'contain', background: '#f5f1e9' }).jpeg().toBuffer(),
    left: (index % 3) * 360 + 16,
    top: Math.floor(index / 3) * 700 + 70,
  })));
  await board.composite(composites).jpeg({ quality: 90 }).toFile(resolve(output, 'reference-board.jpg'));
  return assets;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const output = resolve(options.output);
  const referencePath = resolve(options.reference);
  const images = options.images.map((path) => resolve(path));
  if (!existsSync(referencePath)) fail(`Reference JSON does not exist: ${referencePath}`);
  for (const path of images) if (!existsSync(path)) fail(`Input image does not exist: ${path}`);
  const reference = JSON.parse(readFileSync(referencePath, 'utf8'));
  if (!reference.productName || !reference.identity?.mustPreserve || !reference.sceneIntent) fail('Reference JSON needs productName, identity.mustPreserve, and sceneIntent.');

  mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const assets = await buildReferenceAssets(output, images);
  const scenes = [
    { id: 'wearer-hero', durationFrames: 90, intent: 'Believable vertical lifestyle hero: a person wearing the blouse, waist-up, with all protected details readable.', fallback: 'Styled ghost-mannequin or rack hero in a new editorial room.' },
    { id: 'collar-button-review', durationFrames: 90, intent: 'New close review scene showing the double collar, yoke ruffle, three flower buttons, and pintucks.', fallback: 'Premium macro commercial scene using the construction-detail reference.' },
    { id: 'silhouette', durationFrames: 90, intent: 'New full-garment scene showing loose babydoll drape and puffed sleeves on a wearer or styled display.', fallback: 'Newly staged full-garment commercial scene; never claim an unseen back view.' },
    { id: 'fabric-cuff', durationFrames: 90, intent: 'New tactile review scene showing matte cotton/poplin texture and ruffled cuff construction.', fallback: 'Designed macro product-commercial scene based on the detail reference.' },
    { id: 'cta-hero', durationFrames: 90, intent: 'New hero/reviewer closing scene with clear product presentation and room for CTA.', fallback: 'Premium editorial product hero with source-faithful garment.' },
  ];
  const manifest = {
    schemaVersion: 1, phase: 2, createdAt: startedAt, product: reference, assets,
    timeline: { width: 1080, height: 1920, fps: 30, totalFrames: 450, durationSeconds: 15, scenes },
    acceptance: {
      phase2: 'Fallback export must be technically valid and preserve source evidence. It is a control/reference only, not product-goal acceptance.',
      phase3: 'Accepted generated scenes must satisfy every protected garment detail and look like new marketing content, not animated raw catalog uploads.',
    },
  };
  writeJson(resolve(output, 'product-reference-manifest.json'), manifest);

  const metrics = { phase: 2, startedAt, renderer: 'phase2-source-photo-fallback-control', steps: [] };
  const titles = ['Product reference', 'Construction detail', 'Silhouette reference', 'Fabric & finish', 'Marketing scene brief'];
  const sequence = Array.from({ length: 5 }, (_, index) => index % images.length);
  for (let index = 0; index < 5; index += 1) {
    const overlay = resolve(output, `overlay-${index}.png`);
    const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="220" fill="#f5f1e9"/><rect y="1620" width="1080" height="300" fill="#f5f1e9"/><text x="72" y="110" font-family="Arial" font-size="25" letter-spacing="4" fill="#536276">PHASE 2 • FALLBACK CONTROL</text><text x="72" y="1720" font-family="Arial" font-size="42" fill="#24344a">${xmlText(titles[index])}</text><text x="72" y="1782" font-family="Arial" font-size="22" fill="#536276">Source evidence — not a generated marketing scene</text><rect x="72" y="1820" width="${160 + index * 130}" height="3" fill="#536276"/></svg>`;
    await sharp(Buffer.from(svg)).png().toFile(overlay);
    const zoom = index % 2 ? '1.05-0.00042*on' : '1+0.00042*on';
    const filter = `[0:v]scale=1920:2760:force_original_aspect_ratio=decrease,pad=1920:2760:(ow-iw)/2:(oh-ih)/2:color=0xf5f1e9,zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=96:s=960x1380:fps=30,pad=1080:1920:60:220:color=0xf5f1e9,setsar=1[photo];[photo][1:v]overlay=0:0:format=auto,format=yuv420p[v]`;
    runFfmpeg(output, `fallback-shot-${index}`, ['-i', images[sequence[index]], '-i', overlay, '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[v]', '-frames:v', '96', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', resolve(output, `fallback-shot-${index}.mp4`)], metrics);
  }
  const inputs = Array.from({ length: 5 }, (_, index) => ['-i', resolve(output, `fallback-shot-${index}.mp4`)]).flat();
  let graph = '[0:v]settb=AVTB[v0];';
  for (let index = 1; index < 5; index += 1) graph += `[${index}:v]settb=AVTB[s${index}];[v${index - 1}][s${index}]xfade=transition=fade:duration=0.25:offset=${(2.95 * index).toFixed(2)}[v${index}];`;
  const video = resolve(output, 'fallback-control-15s.mp4');
  runFfmpeg(output, 'fallback-compose', [...inputs, '-filter_complex_threads', '1', '-filter_complex', graph.slice(0, -1), '-map', '[v4]', '-frames:v', '450', '-r', '30', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], metrics);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8', timeout: 30000 });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const probeJson = JSON.parse(probe.stdout); const stream = probeJson.streams.find((candidate) => candidate.codec_type === 'video');
  if (stream.width !== 1080 || stream.height !== 1920 || Number(stream.nb_read_frames) !== 450 || Math.abs(Number(probeJson.format.duration) - 15) > 0.04) throw new Error('Fallback output contract failed.');
  writeJson(resolve(output, 'fallback-probe.json'), probeJson);
  runFfmpeg(output, 'fallback-decode-check', ['-i', video, '-f', 'null', '-'], metrics);
  runFfmpeg(output, 'fallback-contact-sheet', ['-i', video, '-vf', 'fps=1/3,scale=216:384,tile=5x1', '-frames:v', '1', resolve(output, 'fallback-contact-sheet.jpg')], metrics);
  metrics.completedAt = new Date().toISOString();
  metrics.technicalValidation = 'passed: 1080x1920, 450 frames, 15 seconds, full decode';
  metrics.limitations = ['Source-photo fallback/control only; it does not create new marketing scenes.', 'No people, cloud generation, segmentation, music, or local AI inference.', 'Phase 3 must use product-reference-manifest.json and its protected identity before any generated scene can be accepted.'];
  writeJson(resolve(output, 'metrics.json'), metrics);
  console.log(JSON.stringify({ ok: true, output, manifest: resolve(output, 'product-reference-manifest.json'), video, referenceBoard: resolve(output, 'reference-board.jpg'), technicalValidation: metrics.technicalValidation }));
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
