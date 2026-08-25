/**
 * Porta 1 (montagem) — `resolveTaskInvocation`: the ONE assembly point that turns
 * a stored config + task into everything a model call needs, running the three
 * BYOK missions in order:
 *
 *   router      → resolveTaskSlot(config, task)     (StaticTaskStrategy → slot + verdict)
 *   acesso      ┐ resolveModelConfig(slot, …)   (build + limiter + tuning + reasoning)
 *   observab.   ┘ + agentModelIdentity(slot)        (usage-attribution quartet)
 *
 * The point: consumers stop wiring these three separately (and dropping one —
 * the review path once shipped without reasoning, the summary path without the
 * limiter). A consumer spreads `callOptions` + `providerOptions` into the SDK
 * call and stamps usage from `usageIdentity`; nothing to re-derive, nothing to
 * forget.
 *
 * Degrades, never throws: no BYOK / BLOCKED verdict / unresolvable slot →
 * `slot: undefined` → env/managed default model, empty tuning, `isByok: false`.
 *
 * Secret hygiene: the slot carries ENCRYPTED apiKey ciphertext; only
 * `buildModelFromSlot` (inside resolveModelConfig) touches plaintext.
 */
import type { BYOKConfig, LlmTask, NormalizedModel } from './byok-config';
import type { RequestContext, RoutingVerdict } from './routing-strategy';
import { resolveTaskSlot } from './resolve-task-model';
import {
    resolveModelConfig,
    type ModelInvocation,
    type ResolveModelInvocationOptions,
} from './model-invocation';
import { agentModelIdentity, type ModelIdentity } from './model-identity';

export interface ResolveTaskInvocationOptions
    extends ResolveModelInvocationOptions {
    /** Per-request routing inputs (folder/repo override, parent-task inherit)
     *  handed to the router (`StaticTaskStrategy`). */
    ctx?: RequestContext;
}

export interface TaskInvocation extends ModelInvocation {
    /** The resolved slot (ciphertext apiKey), or `undefined` for the
     *  env/managed-default path. Thread it to `recordAgentRunUsage` / a wrapper
     *  when the caller needs the slot itself. */
    slot: NormalizedModel | undefined;
    /** The routing verdict, or `undefined` when the config is not v2. */
    verdict: RoutingVerdict | undefined;
    /** Usage-attribution identity derived from the slot (`model` / `isByok` /
     *  `byokModelId` / `credentialId`) — spread it into the usage record so
     *  spend attributes by stable id, never re-derived at the call site. */
    usageIdentity: ModelIdentity;
}

/**
 * Resolve `task` over the org's config into a ready-to-call invocation. This is
 * `resolveTaskSlot` (router) + `resolveModelConfig` (access + tuning +
 * reasoning) + `agentModelIdentity` (usage), composed once.
 */
export function resolveTaskInvocation(
    config: BYOKConfig | null | undefined,
    task: LlmTask,
    options: ResolveTaskInvocationOptions,
): TaskInvocation {
    const { ctx, ...invocationOptions } = options;

    const { slot, verdict } = resolveTaskSlot(config, task, { ctx });
    const invocation = resolveModelConfig(slot, invocationOptions);

    return {
        ...invocation,
        slot,
        verdict,
        // `usageIdentity.model` and `invocation.modelName` are the SAME concept
        // (both getModelName(slot)); pin the identity's model to the invocation's
        // name so they can never drift — notably on the env-default path where a
        // `defaultModelOverride` makes the two derivations disagree (the name
        // honors the override, the bare identity would not). Usage must attribute
        // to the model that actually ran.
        usageIdentity: { ...agentModelIdentity(slot), model: invocation.modelName },
    };
}
