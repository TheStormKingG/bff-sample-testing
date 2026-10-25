import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

// GitHub Pages serves this app from https://OWNER.github.io/REPO/.
// `base` must therefore be '/REPO/' in a Pages build and '/' for local dev.
// The deploy workflow sets VITE_BASE_PATH from the repository name so the value
// is never guessed or hardcoded to one particular repo slug.
const basePath = process.env.VITE_BASE_PATH ?? '/';

export default defineConfig({
  base: basePath,
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // do not publish sourcemaps to a public static host
    target: 'es2022',
  },
  server: { port: 5173, strictPort: false },
});
