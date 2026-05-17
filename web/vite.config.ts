import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, '../src'),
      buffer: 'buffer/',
    },
  },
  define: {
    global: 'globalThis',
    'process.env': JSON.stringify({}),
  },
  build: {
    target: 'es2022',
    rollupOptions: {
      plugins: [],
    },
  },
  server: {
    port: 5173,
    host: true,
  },
});
