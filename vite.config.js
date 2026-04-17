import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import os from 'os'

export default defineConfig({
  plugins: [react()],
  cacheDir: resolve(os.tmpdir(), 'vite-cache-maint-report-web'),
})
