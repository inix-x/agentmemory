// A hook fires once and exits, so a failed POST used to vanish: the caller
// swallowed the error and the process was gone before anything noticed.
// Retries once on a bad status or a network error, and never rejects.
const RETRY_DELAY_MS = 100;

export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  attemptMs = 400,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      // Fresh signal per attempt: a reused one arrives already spent.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(attemptMs),
      });
      if (res.ok) return;
    } catch (err) {
      // A timeout leaves delivery UNKNOWN, so retrying it can duplicate.
      // See the "does not retry after a client timeout" tests.
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") return;
    }
  }
}
