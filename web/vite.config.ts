import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    strictPort: true,
    // Same-origin API in development, so the session cookie is first-party.
    proxy: { '/api': 'http://127.0.0.1:3000' },
  },
});
