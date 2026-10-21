import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  // Bundle the workspace protocol package (shipped as TypeScript source);
  // keep real npm dependencies external so they are installed normally.
  noExternal: ['@meet-strangers/shared'],
});
