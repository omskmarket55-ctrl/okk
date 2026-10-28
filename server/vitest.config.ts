import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: { LOG_LEVEL: 'silent' },
    // Сквозной тест пересоздаёт схему базы: файлы с базой не запускаем параллельно
    fileParallelism: false,
  },
});
