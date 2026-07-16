import { defineConfig } from 'tsup';

/**
 * tsup 打包配置。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  clean: true,
  dts: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  shims: false,
  banner: {
    js: '#!/usr/bin/env node',
  },
});
