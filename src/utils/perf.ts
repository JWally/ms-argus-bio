// Lightweight performance instrumentation — zero cost when DevTools is closed.
// Markers show up in Chrome DevTools flame charts and are collected by the profiler script.

export function markStart(label: string): void {
  performance.mark(`${label}:start`);
}

export function markEnd(label: string): void {
  performance.mark(`${label}:end`);
  performance.measure(label, `${label}:start`, `${label}:end`);
}

/** Wrap an async function with performance markers. */
export async function measureAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
  markStart(label);
  try {
    return await fn();
  } finally {
    markEnd(label);
  }
}

/** Wrap a sync function with performance markers. */
export function measureSync<T>(label: string, fn: () => T): T {
  markStart(label);
  try {
    return fn();
  } finally {
    markEnd(label);
  }
}

/** Install a PerformanceObserver for long tasks (>50ms). Entries are collected by the profiler. */
export function observeLongTasks(): void {
  if (typeof PerformanceObserver === 'undefined') return;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        // eslint-disable-next-line no-console
        console.warn(`[PERF] Long task: ${Math.round(entry.duration)}ms`, entry);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch {
    // longtask not supported in this browser
  }
}
