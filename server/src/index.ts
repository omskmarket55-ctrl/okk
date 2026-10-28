import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { migrate } from './db/migrate.js';
import { seedUsers } from './db/users.js';
import { buildApp } from './app.js';
import { seedDemo } from './demo/seed.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
await migrate(db);
const seeded = await seedUsers(db, { login: config.initialAdminLogin, password: config.initialAdminPassword });

if (config.demo && (await seedDemo(db, config.phoneKey))) console.log('Демо: загружены примерные клиенты, вход оператора — operator / operator-demo');

const { app, ctx } = await buildApp(config, db);
if (seeded === 'created') app.log.info(`Создан администратор «${config.initialAdminLogin}» — пароль в INITIAL_ADMIN_PASSWORD (.env)`);
if (seeded === 'no_password') app.log.warn('В базе нет сотрудников: задайте INITIAL_ADMIN_PASSWORD в .env и перезапустите');

await app.listen({ port: config.port, host: '0.0.0.0' });
ctx.scheduler.start();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    ctx.scheduler.stop();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
