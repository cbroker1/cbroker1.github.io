// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  site: 'https://cbroker1.github.io',
  base: '/',
  output: 'static',
  integrations: [sitemap()],
  vite: {
    define: {
      'import.meta.env.VITE_ASSISTANT_FUNNEL_URL': JSON.stringify(
        process.env.VITE_ASSISTANT_FUNNEL_URL ?? ''
      ),
      'import.meta.env.VITE_ASSISTANT_MODEL': JSON.stringify(
        process.env.VITE_ASSISTANT_MODEL ?? 'qwen3.6-35b-a3b-mtp-q8-accurate'
      ),
    },
  },
});
