import { defineConfig } from 'astro/config';

// GitHub Pages のプロジェクトページに置く場合は
// BASE_PATH=/リポジトリ名 を指定してビルドする。
const base = process.env.BASE_PATH || '/';

export default defineConfig({
  site: process.env.SITE_URL,
  base,
  build: {
    format: 'directory',
  },
});
