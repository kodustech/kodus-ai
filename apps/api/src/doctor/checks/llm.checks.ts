import { describeEnvLLMConfig } from '@libs/llm/env-llm-config';
import { LLM_TASK } from '@libs/llm/llm-tasks';
import { LLM } from '@libs/llm/llm';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import type { BYOKConfig, NormalizedModel } from '@libs/llm/byok-config';

import { DoctorCheck, DoctorContext, DoctorResult } from '../doctor.types';

export const MIN_CONTEXT_WINDOW = 64_000;
const PROBE_TIMEOUT_MS = 60_000;

export interface LlmDeps {
    getBYOKConfig(organizationId: string): Promise<BYOKConfig | null>;
    /** One real completion; resolves when the model answered. */
    complete(params: {
        slot?: NormalizedModel;
        organizationId?: string;
    }): Promise<void>;
}

export const liveLlmComplete: LlmDeps['complete'] = async ({
    slot,
    organizationId,
}) => {
    await LLM.run({
        // Strip the runtime fallback so a broken primary is reported, not
        // silently covered by the fallback model.
        byokConfig: slot ? { ...slot, fallback: undefined } : undefined,
        user: 'Reply with the single word OK.',
        runName: 'selfhosted-doctor',
        organizationId,
        // No output cap: reasoning models spend it thinking and would fail a
        // probe that the review itself passes.
        timeoutMs: PROBE_TIMEOUT_MS,
    });
};

function modelLabel(slot?: NormalizedModel, envModel?: string): string {
    if (slot) {
        return [slot.provider, slot.model].filter(Boolean).join(' / ');
    }
    return envModel ?? 'the default model';
}

function errorText(error: any): string {
    return String(error?.message ?? error).slice(0, 200);
}

/**
 * Which model each org's reviews actually run on, a real completion on it,
 * and whether it is big enough. Mirrors the review path: BYOK routes via
 * resolveTaskSlot (codeReview task); no slot means the env/managed model.
 */
export function llmCheck(deps: LlmDeps): DoctorCheck {
    return {
        id: 'llm',
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const envDescriptor = describeEnvLLMConfig(ctx.env);
            const envModel = envDescriptor.configured
                ? envDescriptor.model
                : undefined;
            const tested = new Map<string, DoctorResult | null>();

            const orgs = new Map<string, string>();
            for (const team of ctx.teams) {
                orgs.set(team.organizationId, team.organizationName);
            }
            // Before any org exists the env model is still what reviews use.
            if (!orgs.size) {
                orgs.set('', 'install');
            }

            for (const [organizationId, organizationName] of orgs) {
                const scope = organizationId ? organizationName : undefined;
                const config = organizationId
                    ? await deps.getBYOKConfig(organizationId)
                    : null;
                const { slot, verdict } = resolveTaskSlot(
                    config,
                    LLM_TASK.codeReview,
                );

                if (config && !slot) {
                    results.push({
                        check: 'llm.byok_fallback',
                        status: 'warn',
                        scope,
                        title: verdict?.modelId
                            ? `The model chosen for reviews (${verdict.modelId}) has an incomplete credential, so reviews use the server default model instead.`
                            : 'Your own model settings could not be applied, so reviews use the server default model instead.',
                        impact: 'Reviews run on a different model than the one configured, with different cost and quality.',
                        fix: 'Open the BYOK page (user menu > BYOK), re-enter the API key of the review model and save; or remove the custom settings to use the server model on purpose.',
                    });
                }

                if (!slot && !envModel) {
                    results.push({
                        check: 'llm.configured',
                        status: 'fail',
                        scope,
                        title: 'No language model is configured.',
                        impact: 'Reviews cannot run.',
                        fix: 'Set API_LLM_PROVIDER_MODEL and its key (for example API_OPEN_AI_API_KEY) in the server env, or configure a model in the BYOK page (user menu > BYOK).',
                    });
                    continue;
                }

                const label = modelLabel(slot, envModel);
                const key = slot
                    ? `byok:${slot.provider}:${slot.model}:${slot.baseURL ?? ''}:${organizationId}`
                    : 'env';
                if (!tested.has(key)) {
                    try {
                        await deps.complete({
                            slot,
                            organizationId: organizationId || undefined,
                        });
                        tested.set(key, null);
                    } catch (error) {
                        tested.set(key, {
                            check: 'llm.completion',
                            status: 'fail',
                            scope: slot ? scope : undefined,
                            title: `The review model (${label}) did not answer a test request.`,
                            impact: 'Reviews fail when they call the model.',
                            fix: slot
                                ? `Check the API key, model name and base URL in the BYOK page (user menu > BYOK). Provider said: ${errorText(error)}`
                                : `Check API_LLM_PROVIDER_MODEL, its API key and API_OPENAI_FORCE_BASE_URL. Provider said: ${errorText(error)}`,
                        });
                    }
                }
                const failure = tested.get(key);
                if (failure) {
                    if (!results.includes(failure)) {
                        results.push(failure);
                    }
                } else {
                    results.push({
                        check: 'llm.completion',
                        status: 'ok',
                        scope,
                        title: `The review model (${label}) answered a test request.`,
                    });
                }

                const window = resolveContextWindow({
                    byokMaxInputTokens: slot?.maxInputTokens,
                    modelName: slot?.model ?? envModel,
                });
                if (window < MIN_CONTEXT_WINDOW) {
                    results.push({
                        check: 'llm.context_window',
                        status: 'warn',
                        scope,
                        title: `The review model (${label}) reads at most ${window.toLocaleString('en-US')} tokens at once.`,
                        impact: 'Large pull requests are cut down or skipped, and Kody sees less surrounding code.',
                        fix: `Use a model with a context window of ${MIN_CONTEXT_WINDOW.toLocaleString('en-US')} tokens or more, or set its real limit in the BYOK page (user menu > BYOK) if it is larger.`,
                    });
                }
            }

            return results;
        },
    };
}
