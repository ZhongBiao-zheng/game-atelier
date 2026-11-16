import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

const pluginsDir = path.resolve(__dirname, '../plugins')

/** 宿主插件的界面源码在 plugins/<id>/host（ADR-0039），裸模块（react 等）改从 web 的 node_modules 解析。 */
function resolvePluginHostFromWeb(): Plugin {
  return {
    name: 'atelier-plugin-host-resolve',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer || !importer.startsWith(pluginsDir + path.sep)) return null
      if (/^[./\0]/.test(source) || source.startsWith('@/') || source.startsWith('@pricing') || source.startsWith('@audio-caps')) return null
      return this.resolve(source, path.join(__dirname, 'src', 'main.tsx'), { ...options, skipSelf: true })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), resolvePluginHostFromWeb()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@pricing': path.resolve(__dirname, '../src/character_workflow/data/generation_prices.json'),
      '@audio-caps': path.resolve(__dirname, '../src/character_workflow/data/audio_caps.json'),
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
    fs: { allow: [__dirname, path.resolve(__dirname, '../src/character_workflow/data'), path.resolve(__dirname, '../plugins')] },
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
    // 官方插件的界面源码在 web/ 之外（plugins/<id>/ui、plugins/<id>/host），它们的测试也要收进来。
    include: ['src/**/*.{test,spec}.{ts,tsx}', '../plugins/*/ui/**/*.{test,spec}.{ts,tsx}', '../plugins/*/host/**/*.{test,spec}.{ts,tsx}'],
  },
})
