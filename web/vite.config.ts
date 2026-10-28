import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// В разработке фронтенд на :5173, API — на сервере :3000.
// Логику анкеты (server/src/surveys/schema.ts) фронтенд импортирует напрямую — правила одни и те же.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
    },
  },
});
