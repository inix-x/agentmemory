import type { IIIClient } from "iii-sdk";

// iii-sdk's onSocketClose tears down the socket without settling in-flight
// invocations, so a state call made just before the engine drops the worker
// waits out the full 180 s worker budget. Engine primitives answer in
// milliseconds when healthy, so they get a short budget of their own.
export const ENGINE_PRIMITIVE_TIMEOUT_MS = 30000;

// state::list and state::list_groups stay on the worker budget: a whole-scope
// read can legitimately run long on a large store.
const ENGINE_PRIMITIVES = new Set([
  "state::get",
  "state::set",
  "state::update",
  "state::delete",
]);

// Off until boot has loaded the persisted indexes. A cold engine can take over
// a minute to accept the worker, and boot reads queued behind that must not
// fail fast.
let armed = false;

export function armEnginePrimitiveBound(): void {
  armed = true;
}

export function resetEnginePrimitiveBoundForTests(): void {
  armed = false;
}

export function boundEnginePrimitives<T extends IIIClient>(sdk: T): T {
  const bounded = Object.create(sdk) as T;
  bounded.trigger = ((request: Parameters<IIIClient["trigger"]>[0]) =>
    sdk.trigger(
      armed &&
        request.timeoutMs === undefined &&
        ENGINE_PRIMITIVES.has(request.function_id)
        ? { ...request, timeoutMs: ENGINE_PRIMITIVE_TIMEOUT_MS }
        : request,
    )) as T["trigger"];
  return bounded;
}
