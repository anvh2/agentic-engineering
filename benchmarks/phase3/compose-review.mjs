// Standalone Phase 3 review compositor. Inputs must already be accepted or
// conditionally accepted generated scenes; raw catalog photos are not inputs.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const sharp = require(resolve(root, '../eshop/node_modules/sharp'));
const output = resolve(process.argv[2] || 'benchmarks/phase3/run-01');
const candidateDir = resolve(output, 'candidates');
const scenes = [
  resolve(candidateDir, 'product-commercial-v1-conditional.png'),
  resolve(candidateDir, 'construction-macro-v1-conditional.png'),
];
mkdirSync(output, { recursive: true });

function run(label, args, metrics) {
  const began = performance.now();
  const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 1_000_000 });
  writeFileSync(resolve(output, `${label}.log`), result.stderr || '');
  metrics.steps.push({ label, durationSeconds: (performance.now() - began) / 1000, exitCode: result.status });
  if (result.status !== 0) throw new Error(`${label} failed: ${result.error?.message || result.stderr}`);
}

const metrics = { phase: 3, renderer: 'generated-scene-review-compositor', startedAt: new Date().toISOString(), inputs: scenes, steps: [] };
const labels = ['New product scene', 'Construction in focus', 'The full silhouette', 'Made for a closer look', 'A new product moment'];
for (let index = 0; index < 5; index += 1) {
  const overlay = resolve(output, `review-overlay-${index}.png`);
  const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="170" fill="#f5f1e9"/><rect y="1660" width="1080" height="260" fill="#f5f1e9"/><text x="70" y="90" font-family="Arial" font-size="24" letter-spacing="4" fill="#536276">GENERATED-SCENE REVIEW</text><text x="70" y="1745" font-family="Arial" font-size="42" fill="#24344a">${labels[index]}</text><text x="70" y="1805" font-family="Arial" font-size="21" fill="#536276">Phase 3 evaluation — product fidelity still under review</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(overlay);
  const zoom = index % 2 ? '1.055-0.00048*on' : '1+0.00048*on';
  const filter = `[0:v]scale=1080:1600:force_original_aspect_ratio=increase,crop=1080:1600,zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=96:s=1080x1600:fps=30,pad=1080:1920:0:170:color=0xf5f1e9,setsar=1[scene];[scene][1:v]overlay=0:0:format=auto,format=yuv420p[v]`;
  run(`review-shot-${index}`, ['-i', scenes[index % scenes.length], '-i', overlay, '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[v]', '-frames:v', '96', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', resolve(output, `review-shot-${index}.mp4`)], metrics);
}
const inputs = Array.from({ length: 5 }, (_, index) => ['-i', resolve(output, `review-shot-${index}.mp4`)]).flat();
let graph = '[0:v]settb=AVTB[v0];';
for (let index = 1; index < 5; index += 1) graph += `[${index}:v]settb=AVTB[s${index}];[v${index - 1}][s${index}]xfade=transition=fade:duration=0.25:offset=${(2.95 * index).toFixed(2)}[v${index}];`;
const video = resolve(output, 'generated-scene-review-15s.mp4');
run('review-compose', [...inputs, '-filter_complex_threads', '1', '-filter_complex', graph.slice(0, -1), '-map', '[v4]', '-frames:v', '450', '-r', '30', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', video], metrics);
const probe = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_streams', '-show_format', '-of', 'json', video], { encoding: 'utf8', timeout: 30000 });
if (probe.status !== 0) throw new Error(probe.stderr);
const probeJson = JSON.parse(probe.stdout); const stream = probeJson.streams.find((candidate) => candidate.codec_type === 'video');
if (stream.width !== 1080 || stream.height !== 1920 || Number(stream.nb_read_frames) !== 450 || Math.abs(Number(probeJson.format.duration) - 15) > 0.04) throw new Error('Output contract failed.');
writeFileSync(resolve(output, 'generated-scene-review-probe.json'), `${JSON.stringify(probeJson, null, 2)}\n`);
run('review-decode-check', ['-i', video, '-f', 'null', '-'], metrics);
run('review-contact-sheet', ['-i', video, '-vf', 'fps=1/3,scale=216:384,tile=5x1', '-frames:v', '1', resolve(output, 'generated-scene-review-contact-sheet.jpg')], metrics);
metrics.completedAt = new Date().toISOString();
metrics.technicalValidation = 'passed: 1080x1920, 450 frames, 15 seconds, full decode';
metrics.limitations = ['Uses two conditionally accepted generated stills repeated as five editorial shots.', 'Human-model candidate was rejected; this cut uses product-commercial scenes.', 'No local AI motion or music. Phase 4 remains required before the approval gate.'];
writeFileSync(resolve(output, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
console.log(JSON.stringify({ ok: true, video, technicalValidation: metrics.technicalValidation }));
