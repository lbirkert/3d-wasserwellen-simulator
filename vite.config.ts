import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const basePath = process.env.BASE_PATH || undefined;

  return {
    base: basePath,
    build: {
      outDir: 'app/src', // Change to whatever folder name you want
      emptyOutDir: true, // Clean the output directory before building
    },
    server: {
      port: 3000,
      host: '0.0.0.0',
    },
    plugins: [react()],
    define: {
      //  'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
      //  'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY)
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      }
    }
  };
});
