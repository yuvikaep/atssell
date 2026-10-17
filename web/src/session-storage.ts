import { useState } from 'react';

/** State remembered for the browser session (list filters). Falls back to memory if storage is blocked. */
export function useSessionState<T extends string>(key: string, initial: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored !== null && (allowed as readonly string[]).includes(stored) ? (stored as T) : initial;
    } catch {
      return initial;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      sessionStorage.setItem(key, next);
    } catch {
      // Storage unavailable (private mode / blocked); keep the in-memory value.
    }
  };
  return [value, update] as const;
}
