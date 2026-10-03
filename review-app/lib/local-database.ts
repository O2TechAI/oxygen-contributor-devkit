import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';

/** Persistent SQLite implementation of the D1 operations used by the review app. */
export function openLocalDatabase(path: string, migrations: URL | string) {
  const sqlite = new DatabaseSync(path);
  sqlite.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
  const migrationDirectory =
    typeof migrations === 'string' ? migrations : fileURLToPath(migrations);
  try {
    sqlite.exec('BEGIN IMMEDIATE');
    sqlite.exec(
      'CREATE TABLE IF NOT EXISTS oxygen_local_migrations (name TEXT PRIMARY KEY)',
    );
    for (const name of readdirSync(migrationDirectory)
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      if (
        sqlite
          .prepare('SELECT name FROM oxygen_local_migrations WHERE name = ?')
          .get(name)
      )
        continue;
      sqlite.exec(readFileSync(join(migrationDirectory, name), 'utf8'));
      sqlite
        .prepare('INSERT INTO oxygen_local_migrations (name) VALUES (?)')
        .run(name);
    }
    sqlite.exec('COMMIT');
  } catch (error) {
    sqlite.exec('ROLLBACK');
    sqlite.close();
    throw error;
  }

  return {
    prepare(sql: string) {
      const statement = sqlite.prepare(sql);
      let values: SQLInputValue[] = [];
      return {
        bind(...args: SQLInputValue[]) {
          values = args;
          return this;
        },
        run() {
          const result = statement.run(...values);
          return {
            success: true,
            meta: {
              changes: Number(result.changes),
              last_row_id: Number(result.lastInsertRowid),
            },
          };
        },
        all<T = Record<string, unknown>>() {
          return { success: true, results: statement.all(...values) as T[] };
        },
        first<T = Record<string, unknown>>() {
          return (statement.get(...values) as T | undefined) ?? null;
        },
      };
    },
    batch<T>(statements: { run(): T }[]) {
      sqlite.exec('BEGIN IMMEDIATE');
      try {
        const results = statements.map((statement) => statement.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    },
    close() {
      sqlite.close();
    },
  };
}
