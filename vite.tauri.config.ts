import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// A developer feasibility surface; the production renderer stays on Electron.
export default defineConfig({
  root: resolve(__dirname, 'src/tauri-spike'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  define: { 'import.meta.env.VITE_DESKTOP_HOST': JSON.stringify('tauri') },
  server: { host: 'localhost', port: 1420, strictPort: true },
  build: { outDir: resolve(__dirname, 'out/tauri-renderer'), emptyOutDir: true }
})
