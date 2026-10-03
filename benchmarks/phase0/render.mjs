// Isolated Phase 0 experiment. No production imports, database or job integration.
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(import.meta.url);
const sharp = require(resolve(root, '../eshop/node_modules/sharp'));
const output = resolve(process.argv[2] || `${root}/benchmarks/phase0/run-01`);
mkdirSync(output, { recursive: true });
const sourceDir = resolve(root, '.workdir/quick-video/scratchpad/comfy-affiliate-v1/assets/ref');
const inputs = ['overview_3.png', 'detail_3.png', 'overview_1.png'].map(n => resolve(sourceDir, n));
const titles = ['A closer look', 'Flower-shaped buttons', 'The complete silhouette', 'Details worth a closer look', 'Discover the details'];
const order = [0, 1, 2, 1, 0];
const metrics = { startedAt: new Date().toISOString(), renderer: 'phase0-source-photo-motion', cloudCostUsd: 0, steps: [], inputs: inputs.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) };
const start = performance.now();
function run(label, args) {
  const began = performance.now();
  const result = spawnSync('/usr/bin/time', ['-l', 'ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8', timeout: 180000, maxBuffer: 1000000 });
  writeFileSync(`${output}/${label}.log`, result.stderr || '');
  const rss = (result.stderr || '').match(/(\d+)\s+maximum resident set size/);
  metrics.steps.push({ label, durationSeconds: (performance.now() - began) / 1000, maxRssBytes: rss ? Number(rss[1]) : null, exitCode: result.status, args });
  writeFileSync(`${output}/metrics.json`, JSON.stringify(metrics, null, 2));
  if (result.status !== 0) throw new Error(`${label}: ${result.error?.message || result.stderr}`);
  console.log(label, metrics.steps.at(-1).durationSeconds.toFixed(2), 'seconds');
}
for (let i = 0; i < 5; i++) {
  // Typography is a code-generated vector overlay, rasterized for FFmpeg.
  const svg = `<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg"><rect width="1080" height="230" fill="#f5f1e9"/><rect y="1610" width="1080" height="310" fill="#f5f1e9"/><text x="80" y="130" font-family="Arial" font-size="26" letter-spacing="5" fill="#536276">THE PRODUCT EDIT</text><text x="80" y="1720" font-family="Arial" font-size="43" fill="#24344a">${titles[i]}</text><text x="80" y="1780" font-family="Arial" font-size="24" fill="#536276">${i === 4 ? 'Explore the product' : 'Original product photography'}</text><rect x="80" y="1820" width="${(i+1)*160}" height="3" fill="#536276"/></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(`${output}/overlay-${i}.png`);
  const zoom = i % 2 ? '1.055-0.00045*on' : '1+0.00045*on';
  const filter = `[0:v]scale=1920:2760:force_original_aspect_ratio=decrease,pad=1920:2760:(ow-iw)/2:(oh-ih)/2:color=0xf5f1e9,zoompan=z='${zoom}':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=96:s=960x1380:fps=30,pad=1080:1920:60:230:color=0xf5f1e9,setsar=1[photo];[photo][1:v]overlay=0:0:format=auto,format=yuv420p[v]`;
  run(`shot-${i}`, ['-i', inputs[order[i]], '-i', `${output}/overlay-${i}.png`, '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[v]', '-frames:v', '96', '-an', '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18', `${output}/shot-${i}.mp4`]);
}
const args = Array.from({length:5},(_,i)=>['-i',`${output}/shot-${i}.mp4`]).flat();
let graph = '[0:v]settb=AVTB[v0];';
for (let i = 1; i < 5; i++) graph += `[${i}:v]settb=AVTB[s${i}];[v${i-1}][s${i}]xfade=transition=fade:duration=0.25:offset=${(2.95*i).toFixed(2)}[v${i}];`;
run('compose', [...args, '-filter_complex_threads', '1', '-filter_complex', graph.slice(0,-1), '-map','[v4]','-frames:v','450','-r','30','-an','-c:v','libx264','-threads','2','-preset','fast','-crf','18','-pix_fmt','yuv420p','-movflags','+faststart',`${output}/baseline-15s.mp4`]);
metrics.renderWallSeconds = (performance.now() - start) / 1000;
const probe = spawnSync('ffprobe',['-v','error','-count_frames','-show_streams','-show_format','-of','json',`${output}/baseline-15s.mp4`],{encoding:'utf8',timeout:30000});
if(probe.status !== 0) throw new Error(probe.stderr);
const data = JSON.parse(probe.stdout); writeFileSync(`${output}/probe.json`, JSON.stringify(data,null,2));
const v=data.streams.find(s=>s.codec_type==='video');
if(v.width!==1080 || v.height!==1920 || Number(v.nb_read_frames)!==450 || Math.abs(Number(data.format.duration)-15)>0.04) throw new Error('Output contract failed');
run('decode-check',['-i',`${output}/baseline-15s.mp4`,'-f','null','-']);
run('contact-sheet',['-i',`${output}/baseline-15s.mp4`,'-vf','fps=1/3,scale=216:384,tile=5x1','-frames:v','1',`${output}/contact-sheet.jpg`]);
metrics.technicalValidation='passed: 1080x1920, 450 frames, 15 seconds, full decode';
metrics.notes=['One product only; three source photos', 'No generated product pixels; silent baseline; no licensed music supplied', 'Source hands, props and decorative symbols retained', 'RSS is subprocess maximum, not whole-machine/unified-memory peak'];
writeFileSync(`${output}/metrics.json`,JSON.stringify(metrics,null,2));
console.log(JSON.stringify({output:`${output}/baseline-15s.mp4`,renderWallSeconds:metrics.renderWallSeconds}));
