export interface Clock {
  now(): Date;
  /** Returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void;
}

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }

  setInterval(fn: () => void, ms: number): () => void {
    const handle = setInterval(fn, ms);
    return () => clearInterval(handle);
  }
}
