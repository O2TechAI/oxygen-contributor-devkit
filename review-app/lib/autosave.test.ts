import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Autosave } from './autosave.ts';

void test('debounces rapid edits and flushes the latest value before export', async () => {
  const saved: number[] = [];
  const queue = new Autosave<number>(
    async (value) => {
      saved.push(value);
    },
    () => {},
    5,
  );
  queue.enqueue(1);
  queue.enqueue(2);
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(saved, [2]);
  queue.enqueue(3);
  assert.equal(await queue.flush(), true);
  assert.deepEqual(saved, [2, 3]);
  assert.equal(queue.hasPending, false);
});

void test('serializes writes and export waits for edits made during an in-flight save', async () => {
  const saved: number[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queue = new Autosave<number>(
    async (value) => {
      saved.push(value);
      if (value === 1) await gate;
    },
    () => {},
    1000,
  );
  queue.enqueue(1);
  const first = queue.flush();
  queue.enqueue(2);
  queue.enqueue(3);
  const exportWait = queue.flush();
  assert.deepEqual(saved, [1]);
  release();
  assert.deepEqual(await Promise.all([first, exportWait]), [true, true]);
  assert.deepEqual(saved, [1, 3]);
  assert.equal(queue.hasPending, false);
});

void test('failed writes block export and retain edits for explicit retry', async () => {
  let fail = true;
  const states: string[] = [];
  const queue = new Autosave<number>(
    async () => {
      if (fail) throw new Error('Offline');
    },
    (state) => states.push(state),
    1000,
  );
  queue.enqueue(1);
  assert.equal(await queue.flush(), false);
  assert.equal(queue.hasPending, true);
  assert.equal(states.at(-1), 'error');
  fail = false;
  assert.equal(await queue.flush(), true);
  assert.equal(queue.hasPending, false);
  assert.equal(states.at(-1), 'saved');
});
