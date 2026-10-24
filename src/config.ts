import { createRequire } from 'node:module';
import { z } from 'zod';

// package.json sits one level above both src/ and dist/, so the version
// reported by GET /api/health has a single source.
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { version: string };

export const VERSION = pkg.version;

/**
 * Booleans out of the environment are strings, and z.coerce.boolean() would
 * read 'false' as true. Only the four spellings below are accepted, so a typo
 * stops the server instead of silently meaning the opposite of what was meant.
 */
const booleanEnv = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0'], {
      errorMap: () => ({ message: "must be 'true', 'false', '1' or '0'" }),
    })
    .default(fallback)
    .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  HOOKTOPUS_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOOKTOPUS_DATA_DIR: z.string().min(1).default('/data'),
  HOOKTOPUS_PUBLIC_URL: z
    .string()
    .url()
    .default('http://localhost:8080')
    .transform((url) => url.replace(/\/+$/, '')),
  HOOKTOPUS_TRUST_PROXY: booleanEnv('false'),
  HOOKTOPUS_BIN_TTL_HOURS: z.coerce.number().positive().default(24),
  HOOKTOPUS_MAX_STORAGE_MB: z.coerce.number().positive().default(1024),
  HOOKTOPUS_FORWARD_ENABLED: booleanEnv('true'),
});

export type Config = z.infer<typeof envSchema>;

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }

  return result.data;
}
