// @ts-check
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

// https://astro.build/config
export default defineConfig({
  site: 'https://cbroker1.github.io',
  base: '/',
  output: 'static',
  integrations: [react()],
});
