import { defineConfig } from 'tsdown'

// tsdown only transpiles/bundles; `pnpm typecheck` owns type checking.
// The `prepare` script runs this after a git install, so the build must be
// self-contained and must not assume a sibling monorepo checkout.
// fixedExtension: false keeps .js/.d.ts extensions for "type": "module",
// matching the package.json exports map.
export default defineConfig({
  entry: ['src/index.ts', 'src/provider.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  clean: true,
  fixedExtension: false,
})
