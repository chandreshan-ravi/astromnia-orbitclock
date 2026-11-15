import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The OrbitClock engine API (orbitclock5/api.py) runs on port 8510.
export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5180,
    strictPort: true,
    proxy: { '/api': 'http://127.0.0.1:8510' },
  },
})
