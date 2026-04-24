import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import os from 'os'

// 開発URLを http://localhost:5175 に固定。strictPort: true で他プロセス占有時は起動失敗（意図しない別ポート化を防ぐ）
export default defineConfig({
  plugins: [react()],
  cacheDir: resolve(os.tmpdir(), 'vite-cache-maint-report-web'),
  server: {
    port: 5175,
    strictPort: true,
  },
})
