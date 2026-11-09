import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Keep the source-relative location of the frozen YAML in the Hono bundle.
const output = new URL('../dist/', import.meta.url);
await mkdir(new URL('packages/contract/', output), { recursive: true });
await copyFile(new URL('../../../packages/contract/openapi.yaml', import.meta.url),
  new URL('packages/contract/openapi.yaml', output));
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('apps/api/src/index.mjs', output)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['hono', 'pg-native'],
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
