import { describe, expect, it, vi } from "vitest";
import { collectCgroupMemory, readMemoryConfig } from "../src/health/memory.js";

const mount = "29 23 0:26 / /sys/fs/cgroup rw,nosuid - cgroup2 cgroup rw";
function reader(files: Record<string, string>) {
  return async (path: string) => {
    if (!(path in files)) throw new Error("unreadable");
    return files[path];
  };
}
function files(group = "/service") {
  return { "/proc/self/cgroup": `0::${group}\n`, "/proc/self/mountinfo": mount };
}

describe("cgroup v2 measurement", () => {
  it("pairs each visible ancestor's usage with its own refreshed limits", async () => {
    const data = { ...files(), "/sys/fs/cgroup/service/memory.current": "10", "/sys/fs/cgroup/service/memory.max": "1000", "/sys/fs/cgroup/service/memory.high": "max", "/sys/fs/cgroup/memory.current": "99", "/sys/fs/cgroup/memory.max": "100", "/sys/fs/cgroup/memory.high": "80" };
    expect(await collectCgroupMemory(reader(data), "linux")).toEqual({ status: "available", levels: [ { path: "/service", current: 10, max: 1000 }, { path: "/", current: 99, max: 100, high: 80 } ] });
    data["/sys/fs/cgroup/memory.max"] = "200";
    expect((await collectCgroupMemory(reader(data), "linux")).levels[1].max).toBe(200);
  });

  it.each([
    ["/tenant", "/tenant/service", "/service"],
    ["/", "/", "/"],
    ["/", "/service", "/service"],
  ])("resolves mount root %s and process path %s", async (root, group, expected) => {
    const result = await collectCgroupMemory(reader({ ...files(group), "/proc/self/mountinfo": mount.replace(" / /sys", ` ${root} /sys`), [`/sys/fs/cgroup${expected === "/" ? "" : expected}/memory.current`]: "10", [`/sys/fs/cgroup${expected === "/" ? "" : expected}/memory.max`]: "100", [`/sys/fs/cgroup${expected === "/" ? "" : expected}/memory.high`]: "max" }), "linux");
    expect(result.levels[0]).toMatchObject({ path: expected, current: 10, max: 100 });
  });

  it.each(["/other", "/.."])("does not attribute an unmatched mount root %s to this process", async root => {
    const read = vi.fn(reader({
      ...files("/app"),
      "/proc/self/mountinfo": mount.replace(" / /sys", ` ${root} /sys`),
      "/sys/fs/cgroup/app/memory.current": "99",
      "/sys/fs/cgroup/app/memory.max": "100",
    }));
    expect(await collectCgroupMemory(read, "linux")).toEqual({ status: "unavailable", levels: [] });
    expect(read.mock.calls.every(([path]) => path.startsWith("/proc/"))).toBe(true);
  });

  it("uses the mount exposing the full visible ancestry", async () => {
    const result = await collectCgroupMemory(reader({
      ...files("/tenant/service"),
      "/proc/self/mountinfo": mount.replace(" / /sys/fs/cgroup", " /tenant /tenant-cgroup") + "\n" + mount,
      "/sys/fs/cgroup/tenant/service/memory.current": "1",
      "/sys/fs/cgroup/tenant/service/memory.max": "100",
      "/sys/fs/cgroup/tenant/memory.current": "10",
      "/sys/fs/cgroup/tenant/memory.max": "100",
      "/sys/fs/cgroup/memory.current": "99",
      "/sys/fs/cgroup/memory.max": "100",
    }), "linux");
    expect(result.levels).toContainEqual({ path: "/", current: 99, max: 100 });
  });

  it("decodes escaped mount paths and handles high independently", async () => {
    const result = await collectCgroupMemory(reader({ ...files("/"), "/proc/self/mountinfo": mount.replace("/sys/fs/cgroup", "/cg\\040space"), "/cg space/memory.current": "90", "/cg space/memory.high": "80" }), "linux");
    expect(result).toEqual({ status: "partial", levels: [{ path: "/", current: 90, high: 80 }] });
  });

  it.each(["", "-1", "NaN", "Infinity", "1e3", "12oops", "9007199254740992"])("rejects malformed usage %s without discarding valid limits", async current => {
    const result = await collectCgroupMemory(reader({ ...files("/"), "/sys/fs/cgroup/memory.current": current, "/sys/fs/cgroup/memory.max": "100", "/sys/fs/cgroup/memory.high": "max" }), "linux");
    expect(result).toEqual({ status: "partial", levels: [{ path: "/", max: 100 }] });
  });

  it.each(["0", "-1", "", "Infinity", "1024kb", "9007199254740992"])("rejects invalid hard limit %s while retaining high", async max => {
    const result = await collectCgroupMemory(reader({ ...files("/"), "/sys/fs/cgroup/memory.current": "90", "/sys/fs/cgroup/memory.max": max, "/sys/fs/cgroup/memory.high": "80" }), "linux");
    expect(result).toEqual({ status: "partial", levels: [{ path: "/", current: 90, high: 80 }] });
  });

  it("accepts zero usage and unlimited limits", async () => {
    expect(await collectCgroupMemory(reader({ ...files("/"), "/sys/fs/cgroup/memory.current": "0\n", "/sys/fs/cgroup/memory.max": "max", "/sys/fs/cgroup/memory.high": "max" }), "linux")).toEqual({ status: "available", levels: [{ path: "/", current: 0 }] });
  });

  it("handles unavailable and unsupported hosts", async () => {
    expect((await collectCgroupMemory(reader({}), "linux")).status).toBe("unavailable");
    const read = vi.fn();
    expect((await collectCgroupMemory(read, "darwin")).status).toBe("unsupported");
    expect(read).not.toHaveBeenCalled();
  });
});

describe("memory configuration", () => {
  it("uses defaults and explicit overrides", () => {
    expect(readMemoryConfig({}, {}, vi.fn())).toEqual({ memoryWarnPercent: 80, memoryCriticalPercent: 95, memoryHoldSamples: 2 });
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_WARN_PCT: "70", AGENTMEMORY_HEALTH_MEM_CRITICAL_PCT: "90", AGENTMEMORY_HEALTH_MEM_RSS_BUDGET_MB: "128", AGENTMEMORY_HEALTH_MEM_HOLD_SAMPLES: "3" }, { memoryHoldSamples: 1 }, vi.fn())).toEqual({ memoryWarnPercent: 70, memoryCriticalPercent: 90, memoryRssBudgetBytes: 128 * 1024 * 1024, memoryHoldSamples: 1 });
  });
  it.each(["", "0", "-1", "NaN", "Infinity", "101", "95"])("rejects invalid warning %s", value => {
    const warn = vi.fn();
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_WARN_PCT: value }, {}, warn).memoryWarnPercent).toBe(80);
    expect(warn).toHaveBeenCalledTimes(1);
  });
  it("accepts critical 100 and rejects crossed thresholds", () => {
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_CRITICAL_PCT: "100" }, {}, vi.fn()).memoryCriticalPercent).toBe(100);
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_WARN_PCT: "90", AGENTMEMORY_HEALTH_MEM_CRITICAL_PCT: "80" }, {}, vi.fn())).toMatchObject({ memoryWarnPercent: 80, memoryCriticalPercent: 95 });
  });
  it.each(["0", "-1", "1.5", "NaN", "Infinity"])("rejects hold count %s", value => {
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_HOLD_SAMPLES: value }, {}, vi.fn()).memoryHoldSamples).toBe(2);
  });
  it.each(["", "0", "-1", "NaN", "Infinity", "1e300"])("rejects budget %s", value => {
    expect(readMemoryConfig({ AGENTMEMORY_HEALTH_MEM_RSS_BUDGET_MB: value }, {}, vi.fn()).memoryRssBudgetBytes).toBeUndefined();
  });
});
