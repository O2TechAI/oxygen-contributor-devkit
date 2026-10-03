/** Debounce edits, serialize writes, and retain unsaved changes after failures. */
export class Autosave<T> {
  private pending: { value: T } | null = null;
  private running: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;

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
    return this.pending !== null;
  }

  enqueue(value: T) {
    this.pending = { value };
    this.state('pending');
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.flush();
    }, this.delay);
  }

  flush(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    if (!this.pending) return Promise.resolve(true);
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain() {
    while (this.pending) {
      const snapshot = this.pending;
      this.state('saving');
      try {
        await this.save(snapshot.value);
        if (this.pending === snapshot) this.pending = null;
      } catch (error) {
        clearTimeout(this.timer);
        this.state('error', error);
        return false;
      }
    }
    this.state('saved');
    return true;
  }
}
