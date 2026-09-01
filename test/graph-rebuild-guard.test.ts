import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// mem::graph-snapshot-rebuild had two paths that reached a raw
// kv.list(KV.graphNodes) without a size guard. KV.graphNodes was estimated
// at 414 MB in production, well past the ws client's 100 MiB maxPayload,
// so the response frame is rejected at its length header
// (RangeError / WS_ERR_UNSUPPORTED_MESSAGE_LENGTH, close 1009) and the
// worker dies before any Promise.race budget can fire.
//
// 46 such frames drove 2xx from 99% to 23.7%, with /observe losing 1514
// writes in 30 minutes.
//
// Note the sibling path, mem::graph-query (graph.ts ~1043), was already
// correct: it calls checkGraphEnumerable and degrades to the snapshot.
// Only the rebuild path had the gaps.
describe("mem::graph-snapshot-rebuild cannot reach an unsized kv.list", () => {
  const src = readFileSync("src/functions/graph.ts", "utf-8");

  it("force does not bypass a scope already sized past the byte budget", () => {
    // force is an operator opt-in for a small corpus. It must not override
    // blockedScope, which means the snapshot already measured the scope
    // over budget.
    expect(src).toMatch(/const overByteBudget = enumeration\.blockedScope !== null;/);
    expect(src).toMatch(
      /if \(!enumeration\.enumerable && \(!forceRebuild \|\| overByteBudget\)\)/,
    );
  });

  it("a thrown size pre-flight fails closed instead of falling through", () => {
    // The old code logged and fell through to the raw kv.list. Not knowing
    // the size is not permission to attempt the read.
    expect(src).toMatch(/preflightFailed: true/);
    expect(src).not.toMatch(
      /Fall through; the user passed force=true or the snapshot/,
    );
  });

  it("still refuses a too-large corpus without force", () => {
    // Regression guard on the behaviour that already worked.
    expect(src).toMatch(/Rebuild refused: \$\{describeCorpusSize\(enumeration\)\}/);
  });

  it("graph-query keeps its existing snapshot degrade path", () => {
    expect(src).toMatch(/Graph query enumeration refused, using snapshot/);
  });
});
