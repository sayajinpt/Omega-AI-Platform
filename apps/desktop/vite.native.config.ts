import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/** Standalone React UI for omega-desktop (WebView2) — no Electron preload. */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  base: './',
  build: {
    outDir: resolve(__dirname, '../../dist/ui'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'src/renderer/index.native.html'),
        'avatar-monitor': resolve(__dirname, 'src/renderer/avatar-monitor.html'),
        'screen-snip': resolve(__dirname, 'src/renderer/screen-snip.html')
      },
      output: {
        manualChunks(id) {
          if (
            id.includes('chat-companion-send') ||
            id.includes('active-chat-bridge') ||
            id.includes('companion-reply-bridge') ||
            id.includes('companion-chat.ts') ||
            id.includes('companion-resolve.ts') ||
            id.includes('chat-companion-send')
          ) {
            return 'omega-companion-bridge'
          }
        }
      }
    }
  },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@omega/sdk': resolve(__dirname, '../../packages/sdk/src')
    }
  }
})
