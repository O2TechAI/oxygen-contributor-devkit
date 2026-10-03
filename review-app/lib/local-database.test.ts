import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openLocalDatabase } from './local-database.ts';

void test('local review database persists records, applies migrations once, and rolls back failed batches', () => {
  const directory = mkdtempSync(join(tmpdir(), 'oxygen-local-db-'));
  const path = join(directory, 'review.sqlite');
  const migrations = new URL('../drizzle/', import.meta.url);
  try {
    const first = openLocalDatabase(path, migrations);
    first
      .prepare('CREATE TABLE local_test (id TEXT PRIMARY KEY, text TEXT)')
      .run();
    first
      .prepare('INSERT INTO local_test VALUES (?, ?)')
      .bind('I001', 'Workflow\n\nExample')
      .run();
    first.close();

    const reopened = openLocalDatabase(path, migrations);
    try {
      assert.equal(
        reopened
          .prepare('SELECT text FROM local_test WHERE id = ?')
          .bind('I001')
          .first<{ text: string }>()?.text,
        'Workflow\n\nExample',
      );
      assert.ok(
        reopened
          .prepare('PRAGMA table_info(reviews)')
          .all<{ name: string }>()
          .results.some((row) => row.name === 'current_hierarchy_json'),
      );
      assert.throws(() =>
        reopened.batch([
          reopened
            .prepare('INSERT INTO local_test VALUES (?, ?)')
            .bind('I002', 'Should roll back'),
          reopened
            .prepare('INSERT INTO local_test VALUES (?, ?)')
            .bind('I001', 'Duplicate'),
        ]),
      );
      assert.equal(
        reopened
          .prepare('SELECT * FROM local_test WHERE id = ?')
          .bind('I002')
          .first(),
        null,
      );
      assert.equal(
        reopened.prepare('SELECT * FROM local_test').all().results.length,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
