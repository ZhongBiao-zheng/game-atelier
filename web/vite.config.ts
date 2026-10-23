import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'
import fs from 'node:fs'

// Bundle the editor fonts locally: annotation must also work without CDN access.
const annotationFonts = path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
function fontFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name)
    return entry.isDirectory() ? fontFiles(file) : [file]
  })
}

export default defineConfig({
  plugins: [react(), tailwindcss(), {
    name: 'annotation-fonts',
    generateBundle() {
      for (const file of fontFiles(annotationFonts)) {
        this.emitFile({ type: 'asset', fileName: `excalidraw/fonts/${path.relative(annotationFonts, file).split(path.sep).join('/')}`, source: fs.readFileSync(file) })
      }
    },
    configureServer(server) {
      server.middlewares.use('/excalidraw/fonts', (request, response, next) => {
        const file = path.resolve(annotationFonts, `.${decodeURIComponent(request.url?.split('?')[0] ?? '/')}`)
        if (!file.startsWith(`${annotationFonts}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        response.setHeader('Content-Type', 'font/woff2')
        fs.createReadStream(file).pipe(response)
      })
    },
  }],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
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
