import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Relative assets let the same built folder work on Cloudflare Pages or
  // beneath the existing GitHub Pages site without rewriting the app.
  base: './',
  plugins: [react()]
});
