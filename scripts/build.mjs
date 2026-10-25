// Three bundles: the server entry (ESM + CJS), the client entry (ESM + CJS,
// `'use client'` kept on top), and the generator bin (ESM, Node). Types come
// from tsc --declaration into dist/.
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync('package.json', 'utf-8'));

rmSync('dist', { recursive: true, force: true });

const external = ['next', 'react', 'react/jsx-runtime', '@faustine-ai/web-agent'];

for (const [entry, out] of [
  ['src/index.ts', 'dist/index'],
  ['src/client.ts', 'dist/client'],
]) {
  for (const format of ['esm', 'cjs']) {
    await build({
      entryPoints: [entry],
      bundle: true,
      platform: 'neutral',
      target: 'es2022',
      format,
      outfile: `${out}.${format === 'esm' ? 'js' : 'cjs'}`,
      external: [...external, 'node:crypto'],
      banner: entry.includes('client') ? { js: "'use client';" } : undefined,
      mainFields: ['module', 'main'],
    });
  }
}

await build({
  entryPoints: ['src/bin/faustine-next.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/bin/faustine-next.js',
  banner: { js: '#!/usr/bin/env node' },
  define: { __FAUSTINE_NEXT_VERSION__: JSON.stringify(version) },
});
chmodSync('dist/bin/faustine-next.js', 0o755);

execSync('npx tsc --declaration --emitDeclarationOnly --noEmit false --outDir dist/types -p tsconfig.json', { stdio: 'inherit' });
// The two public entry declarations next to the bundles point INTO dist/types
// (a copy would reference ./registry, ./handler… which only exist there).
execSync("find dist/types -name '*.spec.d.ts' -delete", { stdio: 'inherit' });
writeFileSync('dist/index.d.ts', "export * from './types/index';\n");
writeFileSync('dist/client.d.ts', "export * from './types/client';\n");
console.log('built dist/');
