import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port and no browser auto-open.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 1420, strictPort: true, watch: { ignored: ['**/src-tauri/**'] } },
  build: { target: 'es2021', outDir: 'dist', emptyOutDir: true },
  test: { environment: 'jsdom', globals: false, setupFiles: ['src/__tests__/setup.ts'] },
});
