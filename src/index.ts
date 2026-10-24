import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { openDatabase } from './db/index.ts';
import { runMigrations } from './db/migrate.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const db = openDatabase(config);
  const migrations = runMigrations(db);

  const app = await buildApp(config, db);
  app.log.info(
    { schema: migrations.to, applied: migrations.applied },
    migrations.applied.length > 0
      ? `migrations applied: ${migrations.applied.join(', ')}`
      : 'schema up to date, nothing to migrate',
  );

  // Node as PID 1 gets no default SIGTERM handling, so without this a
  // `docker stop` would wait out the ten-second grace period and then kill.
  const shutdown = (signal: NodeJS.Signals): void => {
    app.log.info({ signal }, 'shutting down');
    app
      .close()
      .then(() => {
        db.close();
        process.exit(0);
      })
      .catch((error: unknown) => {
        app.log.error(error, 'failed to shut down cleanly');
        process.exit(1);
      });
  };
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, shutdown);
  }

  // 0.0.0.0 so the port stays reachable from outside a container.
  await app.listen({ port: config.HOOKTOPUS_PORT, host: '0.0.0.0' });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
