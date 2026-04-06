import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig(() => {
  const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? ''
  const base = process.env.GITHUB_ACTIONS === 'true' && repoName ? `/${repoName}/` : '/'

  return {
    base,
    plugins: [
      react(),
      VitePWA({
        registerType: 'autoUpdate',
        includeAssets: ['favicon.svg', 'pwa-icon.svg'],
        manifest: {
          name: 'PeerDrop Fileshare',
          short_name: 'PeerDrop',
          description: 'Browser-only file sharing with QR-based WebRTC pairing.',
          theme_color: '#020617',
          background_color: '#020617',
          display: 'standalone',
          start_url: '.',
          scope: '.',
          icons: [
            {
              src: 'pwa-icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'any',
            },
            {
              src: 'pwa-icon.svg',
              sizes: 'any',
              type: 'image/svg+xml',
              purpose: 'maskable',
            },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,ico}'],
        },
        devOptions: {
          enabled: true,
        },
      }),
    ],
  }
})
