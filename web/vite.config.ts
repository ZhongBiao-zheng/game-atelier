import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@pricing': path.resolve(__dirname, '../src/character_workflow/data/generation_prices.json'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 固定产物文件名（去掉内容哈希）：viewer-server 本机直服，不需要 CDN 缓存失效。
    // 哈希名每次构建都变，git 当成「删旧 + 加新」churn、历史堆冗余 blob；固定名让
    // git 看到同路径 modify，delta 压得动，diff 也干净。
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    fs: { allow: [__dirname, path.resolve(__dirname, '../src/character_workflow/data')] },
    port: 5173,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5174', changeOrigin: true },
      '/events': { target: 'http://127.0.0.1:5174', changeOrigin: true, ws: false },
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    globals: true,
  },
})
