import { describeEnvLLMConfig } from '@libs/llm/env-llm-config';
import {
    isEndpointSuffixWarning,
    isForeignHostWarning,
} from '@libs/llm/env-declared-provider';
import { LLM_TASK, type LlmTask } from '@libs/llm/llm-tasks';
import { LLM } from '@libs/llm/llm';
import { resolveContextWindow } from '@libs/llm/model-context-window';
import { resolveTaskSlot } from '@libs/llm/resolve-task-model';
import { redactSecrets } from '@libs/llm/review-error-diagnostics';
import { validateModelTuning } from '@libs/llm/validate-model-tuning';
import type { BYOKConfig, NormalizedModel } from '@libs/llm/byok-config';

import {
    DoctorCheck,
    DoctorContext,
    DoctorResult,
    reviewableTeams,
} from '../doctor.types';

export const MIN_CONTEXT_WINDOW = 64_000;
const PROBE_TIMEOUT_MS = 60_000;
/** Stays under CHECK_TIMEOUT_MS: a probe past it would drop every result. */
export const LLM_BUDGET_MS = 70_000;

export interface LlmDeps {
    now?: () => number;
    getBYOKConfig(organizationId: string): Promise<BYOKConfig | null>;
    /** One real completion; resolves when the model answered. */
    complete(params: {
        slot?: NormalizedModel;
        organizationId?: string;
        timeoutMs: number;
    }): Promise<void>;
}

export const liveLlmComplete: LlmDeps['complete'] = async ({
    slot,
    organizationId,
    timeoutMs,
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
        timeoutMs,
    });
};

function modelLabel(slot?: NormalizedModel, envModel?: string): string {
    if (slot) {
        return [slot.provider, slot.model].filter(Boolean).join(' / ');
    }
    return envModel ?? 'the default model';
}

/** The provider's sentence without the account or key ids it may echo (#2021). */
function errorText(error: any): string {
    return redactSecrets(String(error?.message ?? error)).slice(0, 200);
}

/**
 * How the server model was set up: whether its provider was stated or guessed,
 * which env vars disagree, and whether its reasoning effort is one the model
 * can honor. Reported once for the install, only when some review runs on it.
 */
function envModelResults(
    descriptor: ReturnType<typeof describeEnvLLMConfig>,
): DoctorResult[] {
    const results: DoctorResult[] = [];
    const label = [descriptor.providerId, descriptor.model]
        .filter(Boolean)
        .join(' / ');

    results.push(
        descriptor.providerSource === 'declared'
            ? {
                  check: 'llm.env_provider',
                  status: 'ok',
                  title: `The server model (${label}) uses the provider set in API_LLM_PROVIDER.`,
              }
            : {
                  check: 'llm.env_provider',
                  status: 'ok',
                  title: `The server model (${label}) uses a provider guessed from the model name and the keys and base URL set.`,
                  fix: 'Set API_LLM_PROVIDER to state the provider instead of letting Kodus guess it.',
              },
    );

    for (const warning of descriptor.warnings ?? []) {
        results.push(
            isEndpointSuffixWarning(warning)
                ? {
                      check: 'llm.env_base_url',
                      status: 'info',
                      title: warning,
                      impact: 'As written, the URL would fail on every call; Kodus calls the corrected one instead, so reviews are not affected.',
                      fix: 'Remove the endpoint path from that variable so it ends at the API root (usually /v1).',
                  }
                : isForeignHostWarning(warning)
                  ? {
                        check: 'llm.env_base_url',
                        status: 'warn',
                        title: warning,
                        impact: 'A proxy that only speaks the OpenAI-compatible protocol fails on every call.',
                        fix: 'For a proxy, set API_LLM_PROVIDER=openai_compatible; otherwise remove API_OPENAI_FORCE_BASE_URL.',
                    }
                  : {
                        check: 'llm.env_conflict',
                        status: 'warn',
                        title: warning,
                        impact: 'One of the two values is ignored, and it may be the one you meant.',
                        fix: 'Keep only the API_LLM_* variable, or give both the same value.',
                    },
        );
    }

    for (const issue of validateModelTuning({
        provider: descriptor.providerId,
        model: descriptor.model,
        reasoningEffort: descriptor.reasoningEffort,
    })) {
        results.push({
            check: 'llm.env_tuning',
            status: 'warn',
            title: `API_LLM_REASONING_EFFORT: ${issue.message}`,
            impact: 'The configured reasoning effort is not what the model runs with.',
            fix: 'Change or clear API_LLM_REASONING_EFFORT.',
        });
    }

    return results;
}

/** Tasks a review routes besides codeReview, and what their failure costs. */
export const REVIEW_SIDE_TASKS: Array<{
    task: LlmTask;
    what: string;
    impact: string;
}> = [
    {
        task: LLM_TASK.kodyRulesReview,
        what: 'Kody Rules checks',
        impact: 'Kody Rules are not checked on pull requests.',
    },
    {
        task: LLM_TASK.prSummary,
        what: 'pull request summaries',
        impact: 'Pull request summaries are not written.',
    },
    {
        task: LLM_TASK.riskAssessment,
        what: 'the pre-review risk assessment',
        impact: 'The risk assessment made before each review fails.',
    },
    {
        task: LLM_TASK.codeReviewHeavy,
        what: 'heavy reviews',
        impact: 'Heavy reviews fail.',
    },
    {
        task: LLM_TASK.customAgent,
        what: 'custom agents',
        impact: 'Custom agents do not run.',
    },
];

type ProbeOutcome =
    | { kind: 'ok' }
    /** The primary failed; the fallback the runtime fails over to answered. */
    | { kind: 'fallback'; error: string; fallback: string }
    | { kind: 'failed'; error: string; fallback?: string }
    /** The primary failed; no time was left to test the fallback reviews use then. */
    | { kind: 'fallback_untested'; error: string; fallback: string }
    /** Not started: the budget could not give it its full timeout. */
    | { kind: 'untested' };

/**
 * Which model each org's reviews actually run on, a real completion on it,
 * and whether it is big enough. Mirrors the review path: BYOK routes via
 * resolveTaskSlot (codeReview, and the side tasks of REVIEW_SIDE_TASKS); no
 * slot means the env/managed model. A primary that fails is retried on the
 * fallback the runtime would fail over to (model-failover.ts).
 */
export function llmCheck(deps: LlmDeps): DoctorCheck {
    return {
        id: 'llm',
        blocking: true,
        async run(ctx: DoctorContext): Promise<DoctorResult[]> {
            const results: DoctorResult[] = [];
            const envDescriptor = describeEnvLLMConfig(ctx.env);
            const envModel = envDescriptor.configured
                ? envDescriptor.model
                : undefined;
            /** One probe per model, shared by every caller (they run at once). */
            const outcomes = new Map<string, Promise<ProbeOutcome>>();
            /** One result per probed model, shared by the orgs that use it. */
            const shared = new Map<string, DoctorResult>();
            const reported = new Set<DoctorResult>();
            /** Orgs whose reviews run on the server model, not their own. */
            const envOrgs: string[] = [];
            let usesEnvModel = false;
            const now = deps.now ?? Date.now;
            const deadline = now() + LLM_BUDGET_MS;

            const keyOf = (
                slot: NormalizedModel | undefined,
                organizationId: string,
            ) =>
                slot
                    ? `byok:${slot.provider}:${slot.model}:${slot.baseURL ?? ''}:${organizationId}`
                    : 'env';

            // A probe gets its full timeout or does not start: cutting it
            // short would fail a slow but working model as "did not answer"
            // and blame its key.
            const runProbe = async (
                slot: NormalizedModel | undefined,
                organizationId: string,
            ): Promise<ProbeOutcome> => {
                const call = (target?: NormalizedModel) =>
                    deps.complete({
                        slot: target,
                        organizationId: organizationId || undefined,
                        timeoutMs: PROBE_TIMEOUT_MS,
                    });
                let outcome: ProbeOutcome;
                if (deadline - now() < PROBE_TIMEOUT_MS) {
                    outcome = { kind: 'untested' };
                } else {
                    try {
                        await call(slot);
                        outcome = { kind: 'ok' };
                    } catch (error) {
                        const fallback = slot?.fallback;
                        if (!fallback) {
                            outcome = {
                                kind: 'failed',
                                error: errorText(error),
                            };
                        } else if (deadline - now() < PROBE_TIMEOUT_MS) {
                            // Reviews would fail over to it: a primary that
                            // timed out says nothing about whether they run.
                            outcome = {
                                kind: 'fallback_untested',
                                error: errorText(error),
                                fallback: modelLabel(fallback),
                            };
                        } else {
                            try {
                                await call(fallback);
                                outcome = {
                                    kind: 'fallback',
                                    error: errorText(error),
                                    fallback: modelLabel(fallback),
                                };
                            } catch {
                                outcome = {
                                    kind: 'failed',
                                    error: errorText(error),
                                    fallback: modelLabel(fallback),
                                };
                            }
                        }
                    }
                }
                return outcome;
            };
            const probe = (
                slot: NormalizedModel | undefined,
                organizationId: string,
            ): Promise<ProbeOutcome> => {
                const key = keyOf(slot, organizationId);
                let pending = outcomes.get(key);
                if (!pending) {
                    pending = runProbe(slot, organizationId);
                    outcomes.set(key, pending);
                }
                return pending;
            };

            // Only organizations that review: a sign-up that created its own
            // empty organization would otherwise fail the probe for a model no
            // review calls. With nothing to review yet, every organization
            // still says which model its first review will use.
            const reviewing = reviewableTeams(ctx);
            const orgs = new Map<string, string>();
            for (const team of reviewing.length ? reviewing : ctx.teams) {
                orgs.set(team.organizationId, team.organizationName);
            }
            // Before any org exists the env model is still what reviews use.
            if (!orgs.size) {
                orgs.set('', 'install');
            }

            // Every probe starts now, together: the models of different orgs
            // and tasks are independent, and a probe started after another
            // would only get what that one left of the budget, so a slow but
            // working model would leave the next one untested.
            const configs = new Map<string, BYOKConfig | null>();
            for (const [organizationId] of orgs) {
                const config = organizationId
                    ? await deps.getBYOKConfig(organizationId)
                    : null;
                configs.set(organizationId, config);
                const { slot, verdict } = resolveTaskSlot(
                    config,
                    LLM_TASK.codeReview,
                );
                if (config && !slot && verdict?.modelId) {
                    continue; // blocked before any model is called
                }
                if (slot || envModel) {
                    void probe(slot, organizationId);
                }
                for (const side of config ? REVIEW_SIDE_TASKS : []) {
                    const routed = resolveTaskSlot(config, side.task);
                    if (routed.slot) {
                        void probe(routed.slot, organizationId);
                    }
                }
            }

            /** Side-task lines come after every org's review-model lines. */
            const sideWork: Array<{
                scope?: string;
                organizationId: string;
                config: BYOKConfig;
                reviewKey: string;
                modelsById: Map<string, { model?: string }>;
            }> = [];

            for (const [organizationId, organizationName] of orgs) {
                const scope = organizationId ? organizationName : undefined;
                const config = configs.get(organizationId) ?? null;
                const modelsById = new Map(
                    (config?.models ?? []).map((m) => [m.id, m]),
                );
                const { slot, verdict } = resolveTaskSlot(
                    config,
                    LLM_TASK.codeReview,
                );

                // A named review model with no usable credential blocks every
                // review outside a trial, which self-hosted never is
                // (permissionValidation.service.ts, BYOK integrity).
                if (config && !slot && verdict?.modelId) {
                    const chosen = modelsById.get(verdict.modelId);
                    results.push({
                        check: 'llm.byok_credential',
                        status: 'fail',
                        scope,
                        title: `The model chosen for reviews (${chosen?.model ?? verdict.modelId}) has an incomplete credential.`,
                        impact: 'Every review is skipped ("BYOK Configuration Required"): Kodus does not fall back to the server model for it.',
                        fix: 'Open the BYOK page (user menu > BYOK), re-enter the API key of the review model and save; or remove the custom settings to use the server model on purpose.',
                    });
                    continue;
                }
                if (config && !slot) {
                    results.push({
                        check: 'llm.byok_fallback',
                        status: 'info',
                        scope,
                        title: 'Your BYOK settings route no model to reviews, so reviews use the server default model.',
                        fix: 'Fine if intended; otherwise choose the review model in the BYOK page (user menu > BYOK).',
                    });
                }

                if (!slot && !envModel) {
                    results.push(
                        envDescriptor.invalidReason
                            ? {
                                  check: 'llm.configured',
                                  status: 'fail',
                                  scope,
                                  title: `The server LLM configuration is invalid: ${envDescriptor.invalidReason}`,
                                  impact: 'Reviews cannot run.',
                                  fix: 'Fix the API_LLM_* variables in the server env, or configure a model in the BYOK page (user menu > BYOK).',
                              }
                            : {
                                  check: 'llm.configured',
                                  status: 'fail',
                                  scope,
                                  title: 'No language model is configured.',
                                  impact: 'Reviews cannot run.',
                                  fix: 'Set API_LLM_PROVIDER, API_LLM_PROVIDER_MODEL and API_LLM_API_KEY in the server env, or configure a model in the BYOK page (user menu > BYOK).',
                              },
                    );
                    continue;
                }
                if (!slot) {
                    usesEnvModel = true;
                    if (scope) {
                        envOrgs.push(scope);
                    }
                }

                const label = modelLabel(slot, envModel);
                const key = keyOf(slot, organizationId);
                const outcome = await probe(slot, organizationId);
                const where = slot
                    ? 'Check the API key, model name and base URL in the BYOK page (user menu > BYOK).'
                    : 'Check API_LLM_PROVIDER, API_LLM_PROVIDER_MODEL, API_LLM_API_KEY and API_LLM_BASE_URL.';
                if (outcome.kind === 'ok') {
                    results.push({
                        check: 'llm.completion',
                        status: 'ok',
                        scope,
                        title: `The review model (${label}) answered a test request.`,
                    });
                } else {
                    let result = shared.get(key);
                    if (!result) {
                        result =
                            outcome.kind === 'untested'
                                ? {
                                      check: 'llm.completion',
                                      status: 'unknown',
                                      scope: slot ? scope : undefined,
                                      title: `Did not test the review model (${label}): the doctor ran out of time.`,
                                      fix: 'Run the doctor again; the models of the other organizations were slow to answer.',
                                      blocking: true,
                                  }
                                : outcome.kind === 'fallback_untested'
                                  ? {
                                        check: 'llm.completion',
                                        status: 'unknown',
                                        scope: slot ? scope : undefined,
                                        title: `The review model (${label}) did not answer a test request, and the doctor ran out of time before testing its fallback (${outcome.fallback}), which reviews fail over to.`,
                                        fix: `${where} Provider said: ${outcome.error}`,
                                        blocking: true,
                                    }
                                  : outcome.kind === 'fallback'
                                    ? {
                                          check: 'llm.completion',
                                          status: 'warn',
                                          scope: slot ? scope : undefined,
                                          title: `The review model (${label}) did not answer a test request; its fallback (${outcome.fallback}) did.`,
                                          impact: 'Reviews run on the fallback model, with different cost and quality.',
                                          fix: `${where} Provider said: ${outcome.error}`,
                                      }
                                    : {
                                          check: 'llm.completion',
                                          status: 'fail',
                                          scope: slot ? scope : undefined,
                                          title: outcome.fallback
                                              ? `The review model (${label}) and its fallback (${outcome.fallback}) did not answer a test request.`
                                              : `The review model (${label}) did not answer a test request.`,
                                          impact: 'Reviews fail when they call the model.',
                                          fix: `${where} Provider said: ${outcome.error}`,
                                      };
                        shared.set(key, result);
                    }
                    if (!reported.has(result)) {
                        reported.add(result);
                        results.push(result);
                    }
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

                // Without BYOK every task runs on the model just probed.
                if (config) {
                    sideWork.push({
                        scope,
                        organizationId,
                        config,
                        reviewKey: key,
                        modelsById,
                    });
                }
            }

            for (const {
                scope,
                organizationId,
                config,
                reviewKey,
                modelsById,
            } of sideWork) {
                for (const side of REVIEW_SIDE_TASKS) {
                    const routed = resolveTaskSlot(config, side.task);
                    if (!routed.slot) {
                        if (routed.verdict?.modelId) {
                            const chosen = modelsById.get(
                                routed.verdict.modelId,
                            );
                            results.push({
                                check: 'llm.task_model',
                                status: 'warn',
                                scope,
                                title: `The model chosen for ${side.what} (${chosen?.model ?? routed.verdict.modelId}) has an incomplete credential.`,
                                impact: envModel
                                    ? `${side.what[0].toUpperCase()}${side.what.slice(1)} run on the server default model instead.`
                                    : side.impact,
                                fix: 'Open the BYOK page (user menu > BYOK), re-enter the API key of that model and save.',
                            });
                        }
                        continue;
                    }
                    if (keyOf(routed.slot, organizationId) === reviewKey) {
                        continue;
                    }
                    const sideOutcome = await probe(
                        routed.slot,
                        organizationId,
                    );
                    const sideLabel = modelLabel(routed.slot);
                    if (sideOutcome.kind === 'failed') {
                        results.push({
                            check: 'llm.task_model',
                            status: 'warn',
                            scope,
                            title: `The model routed to ${side.what} (${sideLabel}) did not answer a test request.`,
                            impact: side.impact,
                            fix: `Check the API key, model name and base URL of that model in the BYOK page (user menu > BYOK). Provider said: ${sideOutcome.error}`,
                        });
                    } else if (sideOutcome.kind === 'fallback') {
                        results.push({
                            check: 'llm.task_model',
                            status: 'warn',
                            scope,
                            title: `The model routed to ${side.what} (${sideLabel}) did not answer a test request; its fallback (${sideOutcome.fallback}) did.`,
                            impact: `${side.what[0].toUpperCase()}${side.what.slice(1)} run on the fallback model.`,
                            fix: `Check the API key, model name and base URL of that model in the BYOK page (user menu > BYOK). Provider said: ${sideOutcome.error}`,
                        });
                    } else if (sideOutcome.kind === 'fallback_untested') {
                        results.push({
                            check: 'llm.task_model',
                            status: 'unknown',
                            scope,
                            title: `The model routed to ${side.what} (${sideLabel}) did not answer a test request, and the doctor ran out of time before testing its fallback (${sideOutcome.fallback}).`,
                            fix: `Check the API key, model name and base URL of that model in the BYOK page (user menu > BYOK). Provider said: ${sideOutcome.error}`,
                        });
                    } else if (sideOutcome.kind === 'untested') {
                        results.push({
                            check: 'llm.task_model',
                            status: 'unknown',
                            scope,
                            title: `Did not test the model routed to ${side.what} (${sideLabel}): the doctor ran out of time.`,
                            fix: 'Run the doctor again.',
                        });
                    }
                }
            }

            // The server model is probed once for every org that uses it, so its
            // failure has no single owner. Name them: an admin whose own org runs
            // on BYOK would otherwise read "reviews fail" about reviews that run
            // (#2021).
            const envResult = shared.get('env');
            if (envResult && envOrgs.length) {
                envResult.scope = envOrgs.join(', ');
            }

            if (usesEnvModel) {
                results.push(...envModelResults(envDescriptor));
            }

            return results;
        },
    };
}
