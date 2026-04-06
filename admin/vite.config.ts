import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(() => {
  return {
    plugins: [react(), tailwindcss()],
    build: {
      outDir: '../public',
      emptyOutDir: true,
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify - file watching is disabled to prevent flickering during agent edits.
      port: 4020,
      hmr: process.env.DISABLE_HMR !== 'true',
      allowedHosts: [
      'gw.dev.dora.restry.cn','gateway.clawlines.net', 'relay.restry.cn', 'dev.dora.restry.cn'],
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:18831',
          changeOrigin: true,
        },
        '/ws': {
          target: 'ws://127.0.0.1:18831',
          ws: true,
          changeOrigin: true,
          rewrite: (incomingPath) => incomingPath.replace(/^\/ws/, ''),
        },
        '/backend': {
          target: 'ws://127.0.0.1:18831',
          ws: true,
          changeOrigin: true,
        },
        '/client': {
          target: 'ws://127.0.0.1:18831',
          ws: true,
          changeOrigin: true,
        },
      },
    },
  };
});
