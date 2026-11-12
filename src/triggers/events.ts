import { TriggerAction, type IIIClient } from "iii-sdk";
import type { CompressedObservation, Memory, Session } from "../types.js";
import { KV, fingerprintId } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { emitLiveEvent } from "../viewer/live-events.js";
import { isReflectEnabled } from "../functions/slots.js";
import { CONSOLIDATION_MARKER_KEY } from "../functions/consolidation-status.js";
import {
  detectLlmProviderKind,
  getAgentId,
  getConsolidationCooldownMs,
  isAgentScopeIsolated,
  isConsolidationEnabled,
  isGraphExtractionEnabled,
} from "../config.js";
import { getGraphGeneration } from "../state/graph-generation.js";
import { logger } from "../logger.js";
import { getSummaryTriggerTimeoutMs } from "../functions/summary-state.js";
import { noteMemoryChange, noteSessionChange } from "../state/viewer-counts.js";

// Keys within KV.config recording when the session-stop fan-out last
// dispatched mem::auto-crystallize and mem::skill-extract. Unlike the
// pipeline's run-end marker, these are stamped at check time. Neither job is
// spaced by the pipeline's run, and skill-extract has no in-flight exclusion at
// all, so the check-time stamp is what bounds each to one dispatch per cooldown.
const AUTO_CRYSTALLIZE_MARKER_KEY = "autoCrystallize:lastDispatch";
const SKILL_EXTRACT_MARKER_KEY = "skillExtract:lastDispatch";

const observationFingerprint = (obs: CompressedObservation[], context: string): string =>
  fingerprintId("gx", `${context}|${obs.map((o) => o.id).sort().join(",")}`);

async function graphExtractContext(kv: StateKV): Promise<string> {
  const generation = await getGraphGeneration(kv).catch(() => null);
  return `${generation ?? "legacy"}|${isGraphExtractionEnabled() ? "llm" : "heuristic"}`;
}

async function cooldownPassed(
  kv: StateKV,
  key: string,
  stampOnPass: boolean,
): Promise<boolean> {
  const cooldownMs = getConsolidationCooldownMs();
  if (cooldownMs <= 0) return true; // debounce disabled
  const now = Date.now();
  const marker = await kv
    .get<{ at?: number }>(KV.config, key)
    .catch(() => null);
  const lastAt = typeof marker?.at === "number" ? marker.at : 0;
  if (now - lastAt < cooldownMs) return false;
  if (stampOnPass) await kv.set(KV.config, key, { at: now }).catch(() => {});
  return true;
}

// The consolidation check is a pure read: mem::consolidate-pipeline stamps
// CONSOLIDATION_MARKER_KEY when a run ENDS, so the cooldown measures the gap
// after a run rather than between two checks. Concurrent stops therefore all
// read the same value and all agree, and it is the pipeline's own in-flight
// exclusion that collapses them into one run.
//
// The auto-crystallize and skill-extract checks are still read-check-writes, so
// all three checks run in one step of an in-process chain: concurrent stops
// must not interleave them.
let fanOutCheckChain: Promise<unknown> = Promise.resolve();

function fanOutDue(
  kv: StateKV,
  checkSkillExtract: boolean,
): Promise<{
  consolidate: boolean;
  autoCrystallize: boolean;
  skillExtract: boolean;
}> {
  // The consolidation read goes last, so the time between it and the dispatch
  // holds no other KV round trip in which a run could end and stamp.
  const result = fanOutCheckChain.then(async () => {
    const autoCrystallize = await cooldownPassed(kv, AUTO_CRYSTALLIZE_MARKER_KEY, true);
    const skillExtract =
      checkSkillExtract &&
      (await cooldownPassed(kv, SKILL_EXTRACT_MARKER_KEY, true));
    const consolidate = await cooldownPassed(kv, CONSOLIDATION_MARKER_KEY, false);
    return { consolidate, autoCrystallize, skillExtract };
  });
  fanOutCheckChain = result.catch(() => undefined);
  return result;
}

export function registerEventTriggers(sdk: IIIClient, kv: StateKV): void {
  sdk.registerFunction("event::session::stopped", async (data: { sessionId: string; skipConsolidation?: boolean }) => {
    const summary = await sdk.trigger<typeof data, { unchanged?: boolean } | undefined>({
      function_id: "mem::summarize",
      payload: data,
      timeoutMs: getSummaryTriggerTimeoutMs(),
    });
    if (summary?.unchanged === true) return summary;
    const fireVoid = (function_id: string, payload: unknown) =>
      sdk
        .trigger({ function_id, payload, action: TriggerAction.Void() })
        .catch((err) =>
          logger.warn(function_id + " trigger failed", {
            sessionId: data.sessionId,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    if (isReflectEnabled()) {
      fireVoid("mem::slot-reflect", { sessionId: data.sessionId });
    }
    // Unconditional: mem::graph-extract gates its LLM pass internally.
    try {
      const observations = await kv.list<CompressedObservation>(
        KV.observations(data.sessionId),
      );
      const compressed = observations.filter((o) => o.title);
      if (compressed.length > 0) {
        const session = await kv
          .get<Session>(KV.sessions, data.sessionId)
          .catch(() => null);
        const at = session?.graphExtractedAt;
        const mark = session?.graphExtractedDigest;
        const context = await graphExtractContext(kv);
        let batch = compressed;
        if (typeof at === "string") {
          const seen = compressed.filter((o) => o.timestamp <= at);
          if (observationFingerprint(seen, context) === mark) {
            batch = compressed.filter((o) => o.timestamp > at);
          } else {
            logger.info("graph-extract watermark stale, re-extracting session", {
              sessionId: data.sessionId,
              atOrBelow: seen.length,
              total: compressed.length,
            });
          }
        }
        if (batch.length > 0) {
          const newest = batch.reduce(
            (max, o) => (o.timestamp > max ? o.timestamp : max),
            "",
          );
          await sdk.trigger({
            function_id: "mem::graph-extract",
            payload: { observations: batch },
            action: TriggerAction.Void(),
          });
          if (session) await kv.update(KV.sessions, data.sessionId, [
            { type: "set", path: "graphExtractedAt", value: newest },
            {
              type: "set",
              path: "graphExtractedDigest",
              value: observationFingerprint(compressed, context),
            },
          ]);
        }
      }
    } catch (err) {
      logger.warn("graph-extract trigger failed", {
        sessionId: data.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    // Crystals + lessons consolidation. The stop lifecycle is the single
    // source of truth: event::session::stopped fires for ALL agents (the
    // client-side session-end hook no longer drives consolidation directly).
    // Gated so keyless/zero-LLM users don't fire no-op LLM calls.
    //
    // skipConsolidation suppresses the fan-out when this handler is driven
    // by eviction's stale-session recovery: evict calls session::stopped
    // once per recovered session, then runs ONE final consolidation pass.
    // Without this guard, N recovered sessions launch N concurrent forced
    // full-corpus consolidations plus N crystallizations.
    //
    // Debounce: /session/end is posted by the per-turn Stop hook, so this
    // handler fires on every agent turn. consolidate-pipeline + auto-crystallize
    // are full-corpus LLM work with no internal "nothing changed" guard, so
    // firing them every turn is a cost/latency storm for connected agents.
    // Bound the global corpus consolidation to once per cooldown window.
    if (isConsolidationEnabled() && !data.skipConsolidation) {
      const due = await fanOutDue(kv, detectLlmProviderKind() === "llm");
      if (due.consolidate) {
        fireVoid("mem::consolidate-pipeline", { tier: "all", force: true });
      }
      if (due.autoCrystallize) {
        fireVoid("mem::auto-crystallize", { olderThanDays: 0 });
      }
      if (due.skillExtract) {
        fireVoid("mem::skill-extract", { sessionId: data.sessionId });
      }
    }
    return summary;
  });
  // React to observation count changes and emit a lightweight live event for dashboards/viewer.
  sdk.registerFunction(
    "event::session::observation-count-changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Session;
      new_value?: Session;
    }) => {
      noteSessionChange(payload.old_value, isStateDelete(payload) ? null : payload.new_value);
      if (isOutOfAgentScope(payload.new_value ?? payload.old_value)) {
        return { emitted: false };
      }
      if (isStateDelete(payload)) {
        await sendViewerEvent(sdk, `session-deleted-${payload.key}-${Date.now()}`, "session.deleted", {
          sessionId: payload.key,
        });
        return { emitted: true };
      }
      if (payload.new_value) {
        await sendViewerEvent(sdk, `session-updated-${payload.key}-${Date.now()}`, "session.updated", {
          session: payload.new_value,
        });
      }
      const oldCount = payload.old_value?.observationCount ?? 0;
      const newCount = payload.new_value?.observationCount ?? 0;
      if (newCount <= oldCount) return { emitted: Boolean(payload.new_value) };

      await sendViewerEvent(sdk, `session-activity-${payload.key}-${Date.now()}`, "session.activity", {
        sessionId: payload.key,
        observationCount: newCount,
        delta: newCount - oldCount,
        updatedAt: payload.new_value?.updatedAt ?? new Date().toISOString(),
      });

      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::session::observation-count-changed",
    config: { scope: KV.sessions },
  });

  sdk.registerFunction(
    "event::memory::changed",
    async (payload: {
      key: string;
      event_type: string;
      old_value?: Memory;
      new_value?: Memory;
    }) => {
      const deleted = isStateDelete(payload);
      noteMemoryChange(payload.old_value, deleted ? null : payload.new_value);
      if (isOutOfAgentScope(payload.new_value ?? payload.old_value)) {
        return { emitted: false };
      }
      const memory = payload.new_value;
      const created = !deleted && !payload.old_value;
      let type = "memory.updated";
      if (deleted) type = "memory.deleted";
      else if (created) type = "memory.created";
      await sendViewerEvent(
        sdk,
        `${type.replace(".", "-")}-${payload.key}-${Date.now()}`,
        type,
        deleted
          ? { memoryId: payload.key, isLatest: payload.old_value?.isLatest }
          : {
              memoryId: payload.key,
              type: memory?.type,
              title: memory?.title,
              isLatest: memory?.isLatest,
              updatedAt: memory?.updatedAt,
              memory,
            },
      );
      return { emitted: true };
    },
  );
  sdk.registerTrigger({
    type: "state",
    function_id: "event::memory::changed",
    config: { scope: KV.memories },
  });
}

export function isStateDelete(payload: { event_type: string; new_value?: unknown }): boolean {
  return payload.event_type === "state:deleted" || !payload.new_value;
}

export function isOutOfAgentScope(record: { agentId?: string } | undefined): boolean {
  return isAgentScopeIsolated() && record?.agentId !== getAgentId();
}

export async function sendViewerEvent(
  _sdk: IIIClient,
  id: string,
  type: string,
  data: Record<string, unknown>,
): Promise<void> {
  emitLiveEvent({ id, type, data });
}
