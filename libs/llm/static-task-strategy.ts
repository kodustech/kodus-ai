/**
 * StaticTaskStrategy — the Manual routing policy (Phase 4, plan 04-01).
 *
 * Resolves an LlmTask to a v2 `models[]` id by precedence:
 *
 *     folder/repo override  >  routing.taskOverrides[task]  >  routing.defaultModelId
 *                                                            ↳ (on gate failure) routing.fallbackModelId
 *
 * A candidate is eligible only when its provider's Phase-3 capabilities satisfy
 * the task (TASK_CAPABILITY_REQUIREMENTS). An ineligible / managed / unknown /
 * unresolvable candidate is SKIPPED to the next tier with a human-readable reason;
 * if no candidate qualifies the verdict is BLOCKED (`modelId: null`) — the
 * resolver NEVER throws (a BLOCKED verdict degrades to the env/managed default at
 * the apply site, matching a missing config today).
 *
 * Secret hygiene: the resolver reads `credential.provider` + `model.model` only;
 * it never touches `apiKey` ciphertext and no reason string carries key material
 * (T-04-01-01).
 */
// Import the barrel (not ./providers/registry) so every provider module
// self-registers via side effect — the capability gate needs a populated REGISTRY
// even if nothing else in the process has loaded byok-to-vercel yet.
import { REGISTRY } from './providers';
import type { ModelCapabilities } from './providers/kernel/types';
import type {
    BYOKConfig,
    BYOKCredential,
    BYOKModelConfig,
    LlmTask,
} from './byok-config';
import type {
    ModelRuntimeStats,
    RequestContext,
    RoutingStrategy,
    RoutingVerdict,
} from './routing-strategy';

/** A per-task capability requirement: a named predicate over ModelCapabilities.
 *  `null` = no requirement (any capable-to-run model qualifies). */
type CapabilityRequirement = {
    capability: string;
    satisfied: (caps: ModelCapabilities) => boolean;
} | null;

/**
 * What each task demands of a model's capability profile (REQ-ROUTE-01):
 *  - codeReview: must be able to emit structured output — EITHER natively
 *    (structuredOutput !== 'none') OR via native tool calling. The review is
 *    driven by `generateObject`, which for providers without a native json_schema
 *    (Anthropic, anthropic_compatible/Kimi-Code, Bedrock, never-downgrade
 *    Moonshot) produces the object through a tool call. Gating those out would
 *    wrongly exclude the primary review providers; only a model with neither
 *    path fails.
 *  - prSummary: no hard requirement (free-form text).
 *  - conversation: native tool calling (the agent invokes tools mid-turn).
 */
const TASK_CAPABILITY_REQUIREMENTS: Record<LlmTask, CapabilityRequirement> = {
    codeReview: {
        capability: 'structuredOutput',
        satisfied: (c) =>
            c.structuredOutput !== 'none' || c.toolCalling === 'native',
    },
    prSummary: null,
    conversation: {
        capability: 'toolCalling',
        satisfied: (c) => c.toolCalling === 'native',
    },
};

/** One candidate the precedence chain will try, in order. */
interface Candidate {
    model: BYOKModelConfig;
    tier: string;
    /** W1: a legacy NAME override to apply onto this slot's `.model` (id-THEN-name). */
    nameOverride?: string;
    /** Marks the fallback tier so the reason reads "fallback". */
    isFallback?: boolean;
}

/**
 * The result of gating one candidate. A uniform shape (not a discriminated
 * union) so it narrows correctly even with `strictNullChecks: false` — `reason`
 * is always present; `verdict` is set only when eligible.
 */
interface Evaluation {
    eligible: boolean;
    reason: string;
    verdict?: RoutingVerdict;
}

export class StaticTaskStrategy implements RoutingStrategy {
    resolve(
        task: LlmTask,
        ctx: RequestContext,
        config: BYOKConfig,
        _stats?: ModelRuntimeStats, // reserved for the Auto router — unused in v1
    ): RoutingVerdict {
        const models = config.models ?? [];
        const byId = new Map<string, BYOKModelConfig>(
            models.filter((m) => m && m.id).map((m) => [m.id, m]),
        );
        const creds = new Map<string, BYOKCredential>(
            (config.credentials ?? [])
                .filter((c) => c && c.id)
                .map((c) => [c.id, c]),
        );
        const routing = config.routing ?? {};

        const primary = this.buildPrimaryCandidates(task, ctx, routing, byId);
        const fallback = this.buildFallbackCandidate(routing, byId);
        const requirement = TASK_CAPABILITY_REQUIREMENTS[task];

        const skips: string[] = [];
        // Dedup exact (id + nameOverride) repeats so a model that is BOTH a higher
        // tier and a lower one (e.g. the folder override id == defaultModelId) is
        // gated once, not twice — no redundant capability lookup, no duplicated
        // skip reason. First occurrence wins, so precedence order is untouched; the
        // name-override variant stays distinct from the plain model (different
        // effective model name).
        const seen = new Set<string>();
        for (const candidate of [...primary, ...fallback]) {
            const key = `${candidate.model.id}::${candidate.nameOverride ?? ''}`;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            const outcome = this.evaluate(task, candidate, creds, requirement);
            if (outcome.eligible && outcome.verdict) {
                // Surface any skipped higher-precedence tiers on the winning
                // verdict so the missing-capability trace is observable, not only
                // on a BLOCKED verdict.
                if (skips.length > 0) {
                    return {
                        ...outcome.verdict,
                        reason: `${skips.join('; ')} → ${outcome.verdict.reason}`,
                    };
                }
                return outcome.verdict;
            }
            skips.push(outcome.reason);
        }

        return {
            modelId: null,
            reason:
                skips.length > 0
                    ? `BLOCKED for "${task}": ${skips.join('; ')}`
                    : `BLOCKED for "${task}": no routing target configured`,
        };
    }

    /** override (id-THEN-name) > taskOverride > default. */
    private buildPrimaryCandidates(
        task: LlmTask,
        ctx: RequestContext,
        routing: NonNullable<BYOKConfig['routing']>,
        byId: Map<string, BYOKModelConfig>,
    ): Candidate[] {
        const candidates: Candidate[] = [];

        // The task's routing target (taskOverride > default) — also the base slot
        // a legacy NAME override applies onto.
        const routedId = routing.taskOverrides?.[task] ?? routing.defaultModelId;
        const routedModel = routedId ? byId.get(routedId) : undefined;

        const overrideRef = ctx.override?.modelId?.trim();
        if (overrideRef) {
            const byIdMatch = byId.get(overrideRef);
            if (byIdMatch) {
                // id override → route straight to that model.
                candidates.push({ model: byIdMatch, tier: 'override' });
            } else if (routedModel) {
                // NAME override (W1): not a models[] id → apply the name onto the
                // chosen slot's `.model`, mirroring the legacy byokModel behavior.
                candidates.push({
                    model: routedModel,
                    tier: 'override(name)',
                    nameOverride: overrideRef,
                });
            }
        }

        // taskOverride, then default (skip a tier already queued as the override base).
        const taskOverrideId = routing.taskOverrides?.[task];
        const taskOverrideModel = taskOverrideId
            ? byId.get(taskOverrideId)
            : undefined;
        if (taskOverrideModel) {
            candidates.push({ model: taskOverrideModel, tier: 'taskOverride' });
        }

        const defaultModel = routing.defaultModelId
            ? byId.get(routing.defaultModelId)
            : undefined;
        if (defaultModel && defaultModel !== taskOverrideModel) {
            candidates.push({ model: defaultModel, tier: 'default' });
        }

        return candidates;
    }

    private buildFallbackCandidate(
        routing: NonNullable<BYOKConfig['routing']>,
        byId: Map<string, BYOKModelConfig>,
    ): Candidate[] {
        const fallbackModel = routing.fallbackModelId
            ? byId.get(routing.fallbackModelId)
            : undefined;
        return fallbackModel
            ? [{ model: fallbackModel, tier: 'fallback', isFallback: true }]
            : [];
    }

    /** Run the capability gate for one candidate; return an eligible verdict or a
     *  skip reason. Never throws (an unregistered provider / capabilities() throw
     *  degrades to a skip). */
    private evaluate(
        task: LlmTask,
        candidate: Candidate,
        creds: Map<string, BYOKCredential>,
        requirement: CapabilityRequirement,
    ): Evaluation {
        const { model, tier, nameOverride, isFallback } = candidate;
        const modelName = nameOverride ?? model.model;

        const cred = creds.get(model.credentialId);
        if (!cred) {
            return {
                eligible: false,
                reason: `${tier} "${model.id}": credential "${model.credentialId}" not found`,
            };
        }
        if (cred.managed) {
            return {
                eligible: false,
                reason: `${tier} "${model.id}": credential is managed (env-default path)`,
            };
        }
        if (!cred.provider || !REGISTRY.has(cred.provider)) {
            return {
                eligible: false,
                reason: `${tier} "${model.id}": provider "${cred.provider}" not registered`,
            };
        }

        let caps: ModelCapabilities;
        try {
            caps = REGISTRY.get(cred.provider).capabilities(modelName);
        } catch {
            return {
                eligible: false,
                reason: `${tier} "${model.id}": capability lookup failed for "${modelName}"`,
            };
        }

        if (requirement && !requirement.satisfied(caps)) {
            return {
                eligible: false,
                reason: `${tier} "${model.id}" (${modelName}) lacks required capability "${requirement.capability}" for "${task}"`,
            };
        }

        const reason = isFallback
            ? `resolved "${task}" via fallback to "${model.id}"`
            : `resolved "${task}" via ${tier} to "${model.id}"`;
        return {
            eligible: true,
            reason,
            verdict: {
                modelId: model.id,
                reason,
                ...(nameOverride ? { modelName: nameOverride } : {}),
            },
        };
    }
}
