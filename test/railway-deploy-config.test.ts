import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Fork-only deploy pin. The fork measured a 67 s cold start against upstream's
// 60 s healthcheck window, and compose does not restart a worker that exits 0,
// so Railway's ON_FAILURE policy is the only restart left once the window holds.
describe("deploy/railway/railway.json", () => {
  const deploy = JSON.parse(readFileSync("deploy/railway/railway.json", "utf-8")).deploy;

  it("gives a cold start 300 s before the healthcheck fails the deploy", () => {
    expect(deploy.healthcheckTimeout).toBe(300);
  });

  it("keeps the restart policy on failure", () => {
    expect(deploy.restartPolicyType).toBe("ON_FAILURE");
  });
});
