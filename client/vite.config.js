import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { initialBundleBudget } from './scripts/initialBundleBudget.mjs'

const apiTarget = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3001'

export default defineConfig({
  plugins: [react(), initialBundleBudget()],
  server: {
    port: 5173,
    allowedHosts: true,
    proxy: {
      '/api': apiTarget,
      '/uploads': apiTarget,
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    minify: 'terser',
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          ui: ['lucide-react'],
        },
      },
    },
  },
})
