import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
export default defineConfig({
  plugins: [react()],
  root: __dirname,
  base: './',
  publicDir: path.resolve(__dirname, 'public'),
  build: { outDir: 'dist', emptyOutDir: true },
  server: { strictPort: true, host: '127.0.0.1', port: 5173 }
})
