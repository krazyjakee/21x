import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Full production application, opt-in; Electron and the diagnostic spike stay unchanged. */
export default defineConfig({
  root: resolve(__dirname, 'src/tauri-production'),
  publicDir: resolve(__dirname, 'src/renderer/public'),
  resolve: { alias: { '@': resolve(__dirname, 'src/renderer/src'), '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react(), tailwindcss()],
  define: { 'import.meta.env.VITE_DESKTOP_HOST': JSON.stringify('tauri') },
  server: { host: 'localhost', port: 1421, strictPort: true, fs: { allow: [resolve(__dirname, 'src')] } },
  build: { outDir: resolve(__dirname, 'out/tauri-production-renderer'), emptyOutDir: true }
})
