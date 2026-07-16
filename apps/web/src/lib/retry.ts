export interface RetryOptions {
  signal?: AbortSignal;
  retryDelaysMs: readonly number[];
  shouldRetry: (error: unknown, attempt: number) => boolean;
  wait?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}

export async function retryWithDelays<T>(
  operation: (signal?: AbortSignal) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const wait = options.wait ?? waitForDelay;
  let lastError: unknown;

  for (let attempt = 0; attempt < options.retryDelaysMs.length; attempt += 1) {
    throwIfAborted(options.signal);
    const delayMs = options.retryDelaysMs[attempt] ?? 0;
    if (delayMs > 0) await wait(delayMs, options.signal);

    try {
      const result = await operation(options.signal);
      throwIfAborted(options.signal);
      return result;
    } catch (error) {
      lastError = error;
      const finalAttempt = attempt === options.retryDelaysMs.length - 1;
      if (
        finalAttempt ||
        options.signal?.aborted ||
        !options.shouldRetry(error, attempt)
      ) {
        throw error;
      }
    }
  }

  throw lastError;
}

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof DOMException && error.name === "AbortError"
  ) || (
    error instanceof Error && error.name === "AbortError"
  );
}

function waitForDelay(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(abortReason(signal));
    };
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    timer = setTimeout(finish, delayMs);
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException("The operation was aborted.", "AbortError");
}
