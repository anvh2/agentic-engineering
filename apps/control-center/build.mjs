import { build } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('.', import.meta.url)));
await mkdir('dist', { recursive: true });
await build({
  entryPoints: ['src/main.tsx'],
  bundle: true,
  outfile: 'dist/app.js',
  format: 'esm',
  target: 'es2022',
  minify: true,
  define: { 'process.env.NODE_ENV': '"production"' },
});
await copyFile('index.html', 'dist/index.html');
