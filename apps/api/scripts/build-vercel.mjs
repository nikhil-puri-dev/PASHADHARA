import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const openapi = await readFile(new URL('../../../packages/contract/openapi.yaml', import.meta.url), 'utf8');
await build({
  entryPoints: [fileURLToPath(new URL('../src/index.ts', import.meta.url))],
  outfile: fileURLToPath(new URL('../dist/apps/api/src/index.mjs', import.meta.url)),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg-native'],
  define: { __PASHADHARA_OPENAPI_YAML__: JSON.stringify(openapi) },
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
