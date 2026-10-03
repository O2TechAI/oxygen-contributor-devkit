// Used only by vite.node.config.ts; the Cloudflare runtime keeps its real bindings.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { openLocalDatabase } from './local-database.ts';

const path = resolve(
  process.env.OXYGEN_REVIEW_DB || '.wrangler/node-local/reviews.sqlite',
);
const databaseKey = Symbol.for('oxygen.local.reviewDatabases');
const runtime = globalThis as typeof globalThis & {
  [databaseKey]?: Map<string, ReturnType<typeof openLocalDatabase>>;
};
const databases = (runtime[databaseKey] ??= new Map());
let database = databases.get(path);
if (!database) {
  mkdirSync(dirname(path), { recursive: true });
  database = openLocalDatabase(path, resolve('drizzle'));
  databases.set(path, database);
}

export const env = {
  DB: database,
  OXYGEN_REVIEW_USERNAME: process.env.OXYGEN_REVIEW_USERNAME,
  OXYGEN_REVIEW_PASSWORD: process.env.OXYGEN_REVIEW_PASSWORD,
};
