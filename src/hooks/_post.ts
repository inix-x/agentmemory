// A hook fires once and exits, so a failed POST used to vanish: the caller
// swallowed the error and the process was gone before anything noticed.
// Retries once on a bad status or a network error, and never rejects.
//
// budgetMs is the caller's own exit deadline. Both attempts and the delay
// between them are sized to fit inside it, because a per-attempt timeout
// longer than the budget means a slow first attempt is killed by the exit
// timer before the retry ever runs, which is the case the retry exists for.
export async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: string,
  budgetMs = 1000,
): Promise<void> {
  // Capped: on a large budget an eighth is a long idle pause, and it eats the
  // per-attempt share that a slow server actually needs.
  const retryDelayMs = Math.min(250, Math.floor(budgetMs / 8));
  const attemptMs = Math.floor((budgetMs - retryDelayMs) / 2);

  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, retryDelayMs));
    try {
      // A fresh signal per attempt. A reused one arrives already spent.
      const res = await fetch(url, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(attemptMs),
      });
      if (res.ok) return;
    } catch (err) {
      // A timeout or abort means the outcome is UNKNOWN: the server may have
      // already written the observation and simply not answered in time. The
      // dedup guard cannot help, because it records only after the write
      // completes, so a retry here creates a second observation. Refusals,
      // resets, and bad statuses are certain non-delivery, and retry safely.
      const name = (err as { name?: string })?.name;
      if (name === "TimeoutError" || name === "AbortError") return;
    }
  }
}
