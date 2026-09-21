export interface Clock {
  now(): Date;
  /** Returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void;
  /** One-shot. Returns a cancel function; cancelling after it fires is harmless. */
  setTimeout(fn: () => void, ms: number): () => void;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  setInterval(fn: () => void, ms: number): () => void {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const handle = setTimeout(fn, ms);
    return () => clearTimeout(handle);
  }
}
