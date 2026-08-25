import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The four deploy targets ship copies of one entrypoint, not a shared file:
// three of them build from their own directory and Docker cannot COPY from
// outside the build context. Copies drift silently -- the iii-observability flag
// sat at `true` in three files and `false` in a fourth with nothing recording
// that a decision had been made.
//
// This guard is deliberately not line-indexed. An earlier version pinned line
// numbers and broke on any insertion.
const read = (t: string) =>
  readFileSync(
    fileURLToPath(new URL(`../deploy/${t}/entrypoint.sh`, import.meta.url)),
    "utf8",
  );

const TARGETS = ["railway", "fly", "render", "coolify"] as const;
const files = Object.fromEntries(TARGETS.map((t) => [t, read(t)])) as Record<
  (typeof TARGETS)[number],
  string
>;

/** Body with comments and blank lines dropped, so a comment cannot mask drift. */
const code = (s: string) =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"))
    .join("\n");

describe("deploy entrypoint drift", () => {
  it("coolify and render remain byte-identical", () => {
    expect(files.coolify).toBe(files.render);
  });

  // Railway is the only target that disables the in-memory OTEL exporter. The
  // reason lives in deploy/railway/entrypoint.sh next to the value, so deleting
  // this test cannot lose it.
  it("only railway disables iii-observability", () => {
    expect(files.railway).toMatch(/enabled: false/);
    for (const t of ["fly", "render", "coolify"] as const) {
      expect(files[t]).toMatch(/enabled: true/);
      expect(files[t]).not.toMatch(/enabled: false/);
    }
  });

  it("railway carries its reason next to the value", () => {
    expect(files.railway).toMatch(/2026-08-23[\s\S]{0,120}enabled: false/);
  });

  // The real guard: with the observability line normalised away, railway's
  // executable body must still equal render's. Any other divergence fails here,
  // wherever it is inserted.
  it("railway's executable body matches render apart from that one flag", () => {
    const norm = (s: string) => code(s).replace(/enabled: (true|false)/, "enabled: X");
    expect(norm(files.railway)).toBe(norm(files.render));
  });

  // Fly inserts its own block BEFORE the final exec rather than appending after
  // it, so render's body up to that exec is the shared part.
  it("fly shares render's body up to the final exec", () => {
    const renderBody = code(files.render).split("\n").slice(0, -1);
    const flyBody = code(files.fly).split("\n").slice(0, renderBody.length);
    expect(flyBody).toEqual(renderBody);
  });
});
