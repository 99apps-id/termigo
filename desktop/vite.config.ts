import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      // Never watch Rust build artifacts; cargo writes into target/ while
      // Vite is running, which caused EBUSY watcher crashes on Windows.
      ignored: ['**/src-tauri/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // Termigo uses the current system webview. Avoid an unnecessary downlevel
    // pass that can break modern React output in newer esbuild releases.
    target: 'esnext',
    minify: process.env.TAURI_ENV_DEBUG ? false : 'esbuild',
    sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
  },
});
