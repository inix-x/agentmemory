// Hooks fire once per event and then exit, so a failed POST used to vanish:
// the caller swallowed the error and the process was gone before anything
// could notice. That loses the observation outright.
//
// The loss is not hypothetical. The worker's connection to the engine drops
// and reconnects periodically. A POST landing inside that window gets a 404,
// because the route is briefly unregistered, or a 500, because an in-flight
// state call died with the socket. Reconnect finishes in well under a second,
// so a single retry recovers the event.
//
// Never rejects. A hook must not crash on a delivery failure, and a caller
// that forgets to catch should still exit cleanly.
export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  opts: { timeoutMs?: number; retryDelayMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const retryDelayMs = opts.retryDelayMs ?? 250;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // A fresh signal per attempt. Reusing one would hand the retry a clock
      // that is already spent, or already aborted.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.ok) return;
    } catch {
      // Network error or timeout. Same handling as a bad status.
    }
    if (attempt === 0) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
