import { StringDecoder } from "node:string_decoder";

export const ENGINE_LOG_MAX_TOTAL_BYTES = 32 * 1024 * 1024;
export const ENGINE_LOG_MAX_BYTES_PER_SECOND = 64 * 1024;
export const ENGINE_LOG_MAX_LINE_BYTES = 8 * 1024;
export const ENGINE_LOG_WINDOW_MS = 1000;

export interface EngineLogForwarder {
  push(chunk: Buffer): void;
  flush(): void;
}

export interface EngineLogForwarderOptions {
  prefix: string;
  write: (line: string) => void;
  maxTotalBytes?: number;
  maxBytesPerSecond?: number;
  maxLineBytes?: number;
  windowMs?: number;
  now?: () => number;
}

export function createEngineLogForwarder(
  options: EngineLogForwarderOptions,
): EngineLogForwarder {
  const { prefix, write } = options;
  const maxTotalBytes = options.maxTotalBytes ?? ENGINE_LOG_MAX_TOTAL_BYTES;
  const maxBytesPerSecond =
    options.maxBytesPerSecond ?? ENGINE_LOG_MAX_BYTES_PER_SECOND;
  const maxLineBytes = options.maxLineBytes ?? ENGINE_LOG_MAX_LINE_BYTES;
  const windowMs = options.windowMs ?? ENGINE_LOG_WINDOW_MS;
  const now = options.now ?? Date.now;

  const decoder = new StringDecoder("utf8");
  let pending = "";
  let totalBytes = 0;
  let windowStart = now();
  let windowBytes = 0;
  let droppedBytes = 0;
  let stopped = false;

  function emitLine(line: string, exemptFromRateCap = false): void {
    if (stopped) return;
    const cost = Buffer.byteLength(line) + 1;
    if (totalBytes + cost > maxTotalBytes) {
      stopped = true;
      write(
        `${prefix} log forwarding stopped: ${maxTotalBytes} byte ceiling reached`,
      );
      return;
    }
    if (!exemptFromRateCap && windowBytes + cost > maxBytesPerSecond) {
      droppedBytes += cost;
      return;
    }
    totalBytes += cost;
    windowBytes += cost;
    write(line);
  }

  // The suppression notice is exempt from the rate cap so silent loss is
  // impossible: it is one short line per window, still charged against
  // both counters, so the lifetime ceiling still bounds it.
  function reportDropped(): void {
    if (droppedBytes === 0) return;
    const dropped = droppedBytes;
    droppedBytes = 0;
    emitLine(
      `${prefix} dropped ${dropped} bytes (rate cap ${maxBytesPerSecond} bytes/s)`,
      true,
    );
  }

  function rollWindow(): void {
    if (now() - windowStart < windowMs) return;
    windowStart = now();
    windowBytes = 0;
    reportDropped();
  }

  function emitRecord(record: string): void {
    emitLine(`${prefix} ${record.endsWith("\r") ? record.slice(0, -1) : record}`);
  }

  return {
    push(chunk: Buffer): void {
      if (stopped) return;
      rollWindow();
      pending += decoder.write(chunk);
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        emitRecord(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      if (pending.length >= maxLineBytes) {
        emitRecord(pending);
        pending = "";
      }
    },
    flush(): void {
      if (stopped) return;
      rollWindow();
      pending += decoder.end();
      if (pending.length > 0) {
        emitRecord(pending);
        pending = "";
      }
      reportDropped();
    },
  };
}
