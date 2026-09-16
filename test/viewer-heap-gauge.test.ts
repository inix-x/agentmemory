import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const viewer = readFileSync("src/viewer/index.html", "utf8");
function render(memory: Record<string, unknown>): string {
  const start = viewer.indexOf("    function renderMemoryResources(memory) {");
  const end = viewer.indexOf("\n    }", start) + 6;
  expect(start).toBeGreaterThan(-1);
  return runInNewContext(`${viewer.slice(start, end)}; renderMemoryResources(memory)`, {
    memory,
    esc: (s: unknown) => String(s).replace(/[&<>"']/g, c => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]),
  });
}
const mb = 1024 * 1024;
const base = { heapUsed: 45 * mb, heapTotal: 46 * mb, rss: 511.5 * mb };
const evaluation = {
  source: "heap", usedBytes: 45 * mb, limitBytes: 100 * mb,
  percent: 45, severity: "healthy", available: true,
};

describe("viewer memory resources", () => {
  it("uses server severity even when RSS rounds across the former floor", () => {
    const html = render({ ...base, evaluations: [{ ...evaluation, percent: 80.4, severity: "degraded" }] });
    expect(html).toContain("var(--yellow)");
    expect(html).toContain("80.4%");
    expect(html).not.toContain("var(--red)");
  });
  it("shows held recovery as critical rather than recoloring a low percentage", () => {
    const html = render({ ...base, evaluations: [{ ...evaluation, severity: "critical", transition: "recovering" }] });
    expect(html).toContain("var(--red)");
    expect(html).toContain("Recovery pending");
  });
  it("shows entering critical as pending and caps only the drawn width", () => {
    const html = render({ ...base, evaluations: [{ ...evaluation, percent: 102.2, severity: "degraded", transition: "entering" }] });
    expect(html).toContain("width:100%");
    expect(html).toContain("102.2%");
    expect(html).toContain("Critical pending");
  });
  it("renders old snapshots without an invented pressure limit", () => {
    const html = render(base);
    expect(html).toContain("Memory pressure unavailable");
    expect(html).toContain("Heap: 45 MiB");
    expect(html).not.toContain("var(--red)");
  });
  it("keeps unavailable latched signals visible and escapes their path", () => {
    const html = render({ ...base, evaluations: [{ source: "cgroup-max", path: '<img src=x onerror=alert(1)>', severity: "critical", available: false, transition: "unavailable" }] });
    expect(html).toContain("var(--red)");
    expect(html).toContain("Measurement unavailable");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).not.toContain("NaN");
  });
  it("identifies the cgroup soft limit separately", () => {
    expect(render({ ...base, evaluations: [{ ...evaluation, source: "cgroup-high", severity: "degraded" }] })).toContain("Container throttle");
  });
});


describe("viewer memory alerts", () => {
  const start = viewer.indexOf("    function humanizeHealthFlag(f) {");
  const end = viewer.indexOf("\n    }", start) + 6;
  const humanize = (f: string) => runInNewContext(`${viewer.slice(start, end)}; humanizeHealthFlag(f)`, { f });
  it.each([
    ["memory_critical_heap_96%", "V8 heap", "96%"],
    ["memory_warn_cgroup-high/_110%", "Container throttle", "110%"],
    ["memory_entering_rss", "RSS budget", "Critical pending"],
    ["memory_recovering_heap", "V8 heap", "Recovery pending"],
    ["memory_unavailable_cgroup-max/parent", "Container limit", "Measurement unavailable"],
  ])("describes %s", (slug, source, detail) => {
    expect(humanize(slug)).toContain(source);
    expect(humanize(slug)).toContain(detail);
    expect(humanize(slug)).not.toBe(slug);
  });
  it("keeps legacy snapshots readable", () => {
    expect(humanize("memory_critical_97%_rss557mb")).toContain("process memory 557 MB");
  });
});
