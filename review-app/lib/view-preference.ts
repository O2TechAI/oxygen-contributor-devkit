export type ReviewView = 'cards' | 'split';

const KEY = 'oxygen-review-view';
const listeners = new Set<() => void>();
let current: ReviewView | null = null;

function read(): ReviewView {
  if (current) return current;
  try {
    const saved = window.localStorage.getItem(KEY);
    if (saved === 'cards' || saved === 'split') current = saved;
  } catch {
    // Storage can be unavailable; the default view still works.
  }
  return current ?? 'cards';
}

export function subscribeView(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const readView = read;

export function serverView(): ReviewView {
  return 'cards';
}

export function setView(view: ReviewView) {
  current = view;
  try {
    window.localStorage.setItem(KEY, view);
  } catch {
    // Not remembering the choice is harmless.
  }
  listeners.forEach((listener) => listener());
}
