import { defineConfig } from 'vitest/config';

export default defineConfig({
  // GitHub Pages などサブパスに置いても動くよう相対パスで出力する
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
