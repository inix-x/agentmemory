import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logger, bootLog, bootWarn, setBootVerbose } from "../src/logger.js";

// Railway maps a line written to stdout to severity "info" and a line
// written to stderr to severity "error". Sending every level to stderr
// therefore reports healthy operation as an error, which is what these
// tests pin against.

describe("logger stream routing by level", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      err.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setBootVerbose(false);
  });

  it("writes info to stdout so it is not reported as an error", () => {
    logger.info("Observation captured", { obsId: "obs_1" });

    expect(out.join("")).toContain("[agentmemory] info Observation captured");
    expect(err.join("")).toBe("");
  });

  it("keeps warn on stderr", () => {
    logger.warn("Graph scope enumeration refused", { totalNodes: 29007 });

    expect(err.join("")).toContain(
      "[agentmemory] warn Graph scope enumeration refused",
    );
    expect(out.join("")).toBe("");
  });

  it("keeps error on stderr", () => {
    logger.error("Compression failed", { obsId: "obs_2" });

    expect(err.join("")).toContain("[agentmemory] error Compression failed");
    expect(out.join("")).toBe("");
  });

  it("preserves the existing text format and field encoding", () => {
    logger.info("Observation compressed", { qualityScore: 90 });

    expect(out.join("")).toBe(
      '[agentmemory] info Observation compressed {"qualityScore":90}\n',
    );
  });

  it("routes verbose boot output to stdout and boot warnings to stderr", () => {
    setBootVerbose(true);

    bootLog("Engine: ws://localhost:49134");
    bootWarn("no embedding provider configured");

    expect(out.join("")).toContain("[agentmemory] Engine: ws://localhost:49134");
    expect(err.join("")).toContain(
      "[agentmemory] warn no embedding provider configured",
    );
  });
});
