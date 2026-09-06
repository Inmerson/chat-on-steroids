import { vi } from 'vitest';

const originalWaitFor = vi.waitFor.bind(vi);

// Vitest's vi.waitFor defaults to one second. This suite intentionally exercises real HTTP,
// filesystem and child-process boundaries and already grants those tests a 30-second test budget.
// Keep the polling interval small, but give default condition waits enough headroom for a loaded
// CI runner. Call sites that pass an explicit waitFor option remain unchanged.
vi.waitFor = ((callback, options) =>
  originalWaitFor(callback, options ?? { timeout: 5_000, interval: 50 })) as typeof vi.waitFor;
