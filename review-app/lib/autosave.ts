/** A stale version must be reconciled explicitly, never retried automatically. */
export class SaveConflictError extends Error {}

/** Debounce edits, serialize writes, and retain unsaved changes after failures. */
export class Autosave<T> {
  /**
   * Writes still to make, in order. A plain edit replaces the last entry unless
   * that entry is a committed revision or is being written now.
   */
  private entries: { value: T; separate: boolean }[] = [];
  private writing: { value: T; separate: boolean } | null = null;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private conflict: SaveConflictError | null = null;

  private save: (value: T) => Promise<void>;
  private state: (
    state: 'pending' | 'saving' | 'saved' | 'error',
    error?: unknown,
  ) => void;
  private delay: number;

  constructor(
    save: (value: T) => Promise<void>,
    state: (
      state: 'pending' | 'saving' | 'saved' | 'error',
      error?: unknown,
    ) => void,
    delay = 600,
  ) {
    this.save = save;
    this.state = state;
    this.delay = delay;
  }

  get hasPending() {
    return this.entries.length > 0;
  }

  get isConflicted() {
    return this.conflict !== null;
  }

  /** Call only after the user explicitly resolves or discards the local draft. */
  discardAfterReconciliation() {
    if (this.running)
      throw new Error('Wait for the active save before reconciling.');
    clearTimeout(this.timer);
    this.entries = [];
    this.conflict = null;
    this.state('saved');
  }

  enqueue(value: T) {
    const last = this.entries.at(-1);
    if (last && !last.separate && last !== this.writing) {
      this.entries[this.entries.length - 1] = { value, separate: false };
    } else {
      this.entries.push({ value, separate: false });
    }
    if (this.conflict) {
      this.state('error', this.conflict);
      return;
    }
    this.state('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delay);
  }

  /**
   * Save `value` as a revision of its own, in call order: edits enqueued before
   * it are written first, and edits enqueued after it cannot replace it (which
   * would keep only the later note).
   */
  commit(value: T): Promise<boolean> {
    this.entries.push({ value, separate: true });
    if (this.conflict) {
      this.state('error', this.conflict);
      return Promise.resolve(false);
    }
    return this.flush();
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.conflict) return Promise.resolve(false);
    if (this.running) return this.running;
    if (!this.entries.length) return Promise.resolve(true);
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain() {
    while (this.entries.length) {
      const entry = this.entries[0];
      this.writing = entry;
      this.state('saving');
      try {
        await this.save(entry.value);
        this.entries.shift();
      } catch (error) {
        clearTimeout(this.timer);
        if (error instanceof SaveConflictError) this.conflict = error;
        this.state('error', error);
        return false;
      } finally {
        this.writing = null;
      }
    }
    this.state('saved');
    return true;
  }
}
