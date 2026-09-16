import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dockerComposeArgs } from "./engine-launch.js";

export type DockerEngineTarget =
  | { containerId: string }
  | { composeFile: string; projectName: string; cwd?: string };

export function watchDockerEngine(
  dockerBin: string,
  options: DockerEngineTarget,
  onExit: (code: number) => void,
  onError: (error: Error) => void,
): () => void {
  let child: ChildProcess | undefined;
  let stopped = false;
  const cancel = () => {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", cancel);
    child?.kill();
  };
  const fail = (error: Error) => {
    if (stopped) return;
    stopped = true;
    process.removeListener("exit", cancel);
    onError(error);
  };
  const observe = (containerId: string) => {
    if (stopped) return;
    if (!/^[a-f0-9]{12,64}$/.test(containerId)) {
      fail(new Error("Expected exactly one iii-engine container ID"));
      return;
    }
    try {
      const observer = spawn(dockerBin, ["wait", containerId], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      child = observer;
      let output = "";
      observer.stdout.on("data", (chunk: Buffer) => {
        output = (output + chunk.toString("utf8")).slice(0, 64);
      });
      observer.on("error", fail);
      observer.on("close", (code, signal) => {
        if (stopped) return;
        const containerCode = output.trim();
        if (code !== 0 || !/^\d{1,3}$/.test(containerCode) || Number(containerCode) > 255) {
          fail(new Error(`docker wait failed (code=${code} signal=${signal})`));
          return;
        }
        stopped = true;
        process.removeListener("exit", cancel);
        onExit(Number(containerCode));
      });
      observer.unref();
      (observer.stdout as typeof observer.stdout & { unref?: () => void }).unref?.();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  };
  process.once("exit", cancel);
  try {
    if ("containerId" in options) {
      observe(options.containerId);
    } else {
      child = execFile(
        dockerBin,
        dockerComposeArgs(options.composeFile, options.projectName, ["ps", "--all", "--quiet", "iii-engine"]),
        { encoding: "utf8", timeout: 5_000, maxBuffer: 1024, windowsHide: true, cwd: options.cwd },
        (error, stdout) => {
          if (stopped) return;
          if (error) { fail(error); return; }
          observe(stdout.trim());
        },
      );
    }
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
  return cancel;
}
