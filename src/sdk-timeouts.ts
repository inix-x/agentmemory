import type { ISdk, TriggerRequest } from "iii-sdk";

export const ENGINE_PRIMITIVE_TIMEOUT_MS = 30000;

const ENGINE_PRIMITIVES = new Set([
  "state::get",
  "state::set",
  "state::update",
  "state::delete",
  "stream::set",
  "stream::send",
]);

export function boundEnginePrimitives(sdk: ISdk): ISdk {
  const bounded = Object.create(sdk) as ISdk;
  bounded.trigger = <TInput, TOutput>(request: TriggerRequest<TInput>) =>
    sdk.trigger<TInput, TOutput>(
      request.timeoutMs === undefined &&
        ENGINE_PRIMITIVES.has(request.function_id)
        ? { ...request, timeoutMs: ENGINE_PRIMITIVE_TIMEOUT_MS }
        : request,
    );
  return bounded;
}
