import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import type { CgroupMemory, HealthSnapshot, MemoryEvaluation } from "../types.js";

export interface MemoryConfig {
  memoryWarnPercent: number;
  memoryCriticalPercent: number;
  memoryRssBudgetBytes?: number;
  memoryHoldSamples: number;
}

export const MEMORY_DEFAULTS: MemoryConfig = {
  memoryWarnPercent: 80,
  memoryCriticalPercent: 95,
  memoryHoldSamples: 2,
};

export function readMemoryConfig(
  env: NodeJS.ProcessEnv = process.env,
  overrides: Partial<MemoryConfig> = {},
  warn: (message: string) => void = console.warn,
): MemoryConfig {
  const number = (key: string, fallback: number) =>
    env[key] === undefined ? fallback : Number(env[key]);
  const config: MemoryConfig = {
    memoryWarnPercent: number("AGENTMEMORY_HEALTH_MEM_WARN_PCT", MEMORY_DEFAULTS.memoryWarnPercent),
    memoryCriticalPercent: number("AGENTMEMORY_HEALTH_MEM_CRITICAL_PCT", MEMORY_DEFAULTS.memoryCriticalPercent),
    memoryHoldSamples: number("AGENTMEMORY_HEALTH_MEM_HOLD_SAMPLES", MEMORY_DEFAULTS.memoryHoldSamples),
    ...(env.AGENTMEMORY_HEALTH_MEM_RSS_BUDGET_MB !== undefined
      ? { memoryRssBudgetBytes: Number(env.AGENTMEMORY_HEALTH_MEM_RSS_BUDGET_MB) * 1024 * 1024 }
      : {}),
    ...overrides,
  };
  if (!(config.memoryWarnPercent > 0 &&
    config.memoryWarnPercent < config.memoryCriticalPercent &&
    config.memoryCriticalPercent <= 100)) {
    warn("[agentmemory] invalid health memory thresholds: require 0 < warn < critical <= 100; using 80/95");
    config.memoryWarnPercent = MEMORY_DEFAULTS.memoryWarnPercent;
    config.memoryCriticalPercent = MEMORY_DEFAULTS.memoryCriticalPercent;
  }
  if (!Number.isSafeInteger(config.memoryHoldSamples) || config.memoryHoldSamples < 1) {
    warn("[agentmemory] invalid health memory hold count: using 2 samples");
    config.memoryHoldSamples = MEMORY_DEFAULTS.memoryHoldSamples;
  }
  if (config.memoryRssBudgetBytes !== undefined &&
    !(Number.isFinite(config.memoryRssBudgetBytes) &&
      config.memoryRssBudgetBytes > 0 &&
      config.memoryRssBudgetBytes <= Number.MAX_SAFE_INTEGER)) {
    warn("[agentmemory] invalid health memory RSS budget: leaving budget unconfigured");
    delete config.memoryRssBudgetBytes;
  }
  return config;
}

function parseBytes(raw: string, limit: boolean): number | undefined {
  const value = raw.trim();
  if (!/^\d+$/.test(value)) return undefined;
  const bytes = Number(value);
  return Number.isSafeInteger(bytes) && (limit ? bytes > 0 : bytes >= 0) ? bytes : undefined;
}

export async function collectCgroupMemory(
  read: (path: string) => Promise<string> = path => readFile(path, "utf8"),
  platform: string = process.platform,
): Promise<CgroupMemory> {
  if (platform !== "linux") return { status: "unsupported", levels: [] };
  try {
    const [cgroup, mountinfo] = await Promise.all([
      read("/proc/self/cgroup"), read("/proc/self/mountinfo"),
    ]);
    const group = cgroup.split("\n").find(line => line.startsWith("0::"))?.slice(3);
    const decode = (path: string) => path.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    const mounts = mountinfo.split("\n").filter(line => line.split(" - ")[1]?.split(" ")[0] === "cgroup2").map(line => {
      const fields = line.split(" - ")[0].split(" ");
      return { root: decode(fields[3] ?? ""), mount: decode(fields[4] ?? "") };
    }).filter(({ root, mount }) => root.startsWith("/") && mount.startsWith("/"));
    if (!group?.startsWith("/") || group.split("/").includes("..") || !mounts.length) {
      return { status: "unavailable", levels: [] };
    }
    const selected = mounts.sort((a, b) => a.root.length - b.root.length).find(({ root }) =>
      root === group || group.startsWith(root === "/" ? "/" : root + "/"),
    );
    if (!selected) return { status: "unavailable", levels: [] };
    const relative = selected.root !== "/" &&
      (group === selected.root || group.startsWith(selected.root + "/"))
      ? group.slice(selected.root.length) || "/" : group;
    const boundary = posix.normalize(selected.mount);
    let current = posix.resolve(boundary, "." + relative);
    const paths: string[] = [];
    while (true) {
      paths.push(current);
      if (current === boundary) break;
      current = posix.dirname(current);
    }
    let partial = false;
    const levels = await Promise.all(paths.map(async path => {
      const level: CgroupMemory["levels"][number] = { path: "/" + posix.relative(boundary, path) };
      await Promise.all((["current", "max", "high"] as const).map(async key => {
        try {
          const raw = await read(posix.join(path, `memory.${key}`));
          if (key !== "current" && raw.trim() === "max") return;
          const value = parseBytes(raw, key !== "current");
          if (value === undefined) partial = true;
          else level[key] = value;
        } catch { partial = true; }
      }));
      return level;
    }));
    return { status: partial ? "partial" : "available", levels };
  } catch { return { status: "unavailable", levels: [] }; }
}

export function evaluateMemory(
  memory: HealthSnapshot["memory"],
  config: Pick<MemoryConfig, "memoryWarnPercent" | "memoryCriticalPercent" | "memoryRssBudgetBytes">,
): MemoryEvaluation[] {
  const evaluations: MemoryEvaluation[] = [];
  const add = (
    source: MemoryEvaluation["source"], usedBytes?: number, limitBytes?: number, path?: string,
  ) => {
    const validUsage = Number.isSafeInteger(usedBytes) && usedBytes! >= 0;
    const validLimit = Number.isFinite(limitBytes) && limitBytes! > 0 && limitBytes! <= Number.MAX_SAFE_INTEGER;
    const percent = validUsage && validLimit ? usedBytes! / limitBytes! * 100 : undefined;
    const severity = percent === undefined ? "healthy"
      : source !== "cgroup-high" && percent > config.memoryCriticalPercent ? "critical"
      : percent > config.memoryWarnPercent ? "degraded" : "healthy";
    evaluations.push({
      source,
      ...(path !== undefined ? { path } : {}),
      ...(validUsage ? { usedBytes } : {}),
      ...(validLimit ? { limitBytes } : {}),
      ...(percent !== undefined ? { percent } : {}),
      available: percent !== undefined,
      severity,
    });
  };
  add("heap", memory.heapUsed, memory.heapSizeLimit);
  if (config.memoryRssBudgetBytes !== undefined) add("rss", memory.rss, config.memoryRssBudgetBytes);
  for (const level of memory.cgroup?.levels ?? []) {
    add("cgroup-max", level.current, level.max, level.path);
    add("cgroup-high", level.current, level.high, level.path);
  }
  return evaluations;
}

export interface MemoryHoldState {
  entry: number;
  clear: number;
  latched: boolean;
  source: MemoryEvaluation["source"];
  path?: string;
}

export function holdMemoryCritical(
  evaluations: MemoryEvaluation[],
  states: Map<string, MemoryHoldState>,
  requiredSamples: number,
): MemoryEvaluation[] {
  const key = (evaluation: MemoryEvaluation) => `${evaluation.source}:${evaluation.path ?? ""}`;
  const result = evaluations.map(evaluation => ({ ...evaluation }));
  const present = new Set(result.map(key));
  for (const [id, state] of states) {
    if (!present.has(id)) result.push({
      source: state.source, path: state.path,
      available: false, severity: "healthy",
    });
  }
  for (const evaluation of result) {
    if (evaluation.source === "cgroup-high") continue;
    const id = key(evaluation);
    const state = states.get(id) ?? {
      entry: 0, clear: 0, latched: false, source: evaluation.source, path: evaluation.path,
    };
    if (!evaluation.available) {
      state.entry = state.clear = 0;
      if (state.latched) {
        evaluation.severity = "critical";
        evaluation.transition = "unavailable";
      }
    } else if (evaluation.severity === "critical") {
      state.clear = 0;
      state.entry = Math.min(state.entry + 1, requiredSamples);
      if (state.entry >= requiredSamples) state.latched = true;
      if (!state.latched) {
        evaluation.severity = "degraded";
        evaluation.transition = "entering";
        evaluation.samples = state.entry;
      }
    } else {
      state.entry = 0;
      state.clear = Math.min(state.clear + 1, requiredSamples);
      if (state.clear >= requiredSamples) state.latched = false;
      if (state.latched) {
        evaluation.severity = "critical";
        evaluation.transition = "recovering";
        evaluation.samples = state.clear;
      }
    }
    if (evaluation.transition) evaluation.requiredSamples = requiredSamples;
    if (state.latched || state.entry > 0) states.set(id, state);
    else states.delete(id);
  }
  return result;
}
