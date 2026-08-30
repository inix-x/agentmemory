// A hook fires once and exits, so a failed POST used to vanish: the caller
// swallowed the error and the process was gone before anything noticed.
// Retries once on a bad status or a network error, and never rejects.
//
// A caller's exit timer has to outlast retryDelayMs plus both attempts, or it
// kills the retry before it lands. The hooks use 1000ms against the 250ms here.
export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  retryDelayMs = 250,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      // A fresh signal per attempt. A reused one arrives already spent.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) return;
    } catch {
      // Network error or timeout. Same handling as a bad status.
    }
  }
}
