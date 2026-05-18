import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, '../skill/viewer_server/static'),
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:5174',
      '/events': { target: 'http://127.0.0.1:5174', ws: false },
    },
  },
  test: {
    environment: 'jsdom',
  },
})
