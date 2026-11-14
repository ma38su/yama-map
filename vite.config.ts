import { defineConfig } from 'vitest/config';

// スマホ実機での確認用に、外部（トンネル経由など）からのアクセスも受け付ける
const lan = { host: true, port: 3030, strictPort: true, allowedHosts: true as const };

export default defineConfig({
  // GitHub Pages などサブパスに置いても動くよう相対パスで出力する
  base: './',
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: lan,
  preview: lan,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
