import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { defineConfig } from 'vitest/config';

// スマホ実機での確認用に、外部（トンネル経由など）からのアクセスも受け付ける
const lan = { host: true, port: 3030, strictPort: true, allowedHosts: true as const };

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * Service Worker（src/sw.js）に、このビルドのファイル一覧と版の名前（中身のハッシュ）を埋め込んで dist/sw.js に出す。
 * 版ごとにアプリ本体のキャッシュの名前が変わるので、古い版のファイルは新しい版が有効になったときに消える
 */
function serviceWorker(): Plugin {
  return {
    name: 'yama-map-sw',
    apply: 'build',
    // ページ（index.html）が出力に加わってから一覧を作る
    enforce: 'post',
    generateBundle(_options, bundle) {
      const hash = createHash('sha256');
      const files = ['./', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'];
      for (const name of readdirSync(here('public/routes')).sort()) {
        files.push(`routes/${name}`);
        hash.update(readFileSync(here(`public/routes/${name}`)));
      }
      for (const [name, item] of Object.entries(bundle).sort(([a], [b]) => a.localeCompare(b))) {
        hash.update(name);
        hash.update(item.type === 'chunk' ? item.code : item.source);
        if (name !== 'index.html') files.push(name); // ページは './' として入れる
      }
      const source = readFileSync(here('src/sw.js'), 'utf8')
        .replace('__VERSION__', hash.digest('hex').slice(0, 12))
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

const appVersion = (JSON.parse(readFileSync(here('package.json'), 'utf8')) as { version: string }).version;

export default defineConfig({
  // GitHub Pages などサブパスに置いても動くよう相対パスで出力する
  base: './',
  // アプリの版（package.json の version）。メニューの「動作の記録」に出す
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  plugins: [serviceWorker()],
  server: lan,
  preview: lan,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
