import { createLogger } from '@libs/core/log/logger';
import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    classifyLLMError,
    isTerminalCategory,
} from '@libs/llm/error-classifier';
import { LLM } from '@libs/llm/llm';
import {
    buildFormatPrompt,
    parseFormatResponse,
    type FormattedSuggestion,
    type SuggestionToFormat,
} from './format-prompt';
import {
    looksLikeReviewScaffolding,
    stripReviewScaffolding,
} from './strip-review-scaffolding';

export type { FormattedSuggestion, SuggestionToFormat };

const logger = createLogger('SuggestionFormatter');

/**
 * Hard budget for the whole-batch formatting pass.
 *
 * Raised from 90s once reasoning was turned off below. Production had this pass
 * landing WITHIN A SECOND of the old ceiling on ordinary batches (a batch of 7
 * at 89.1s) and past it on 25 occasions in twelve hours, which is a ceiling
 * chosen too close to the work. 120s buys headroom for a large batch or a slow
 * provider without making a stuck call hold a review much longer — the pass is
 * a secondary polish, and the deterministic fallback already covers whatever it
 * fails to deliver.
 */
const FORMAT_TIMEOUT_MS = 120_000;

/** Per-SUGGESTION budget for an isolated re-format. A single suggestion is a
 *  fraction of the batch, so a slow provider fits comfortably inside a slice
 *  that was too small for the whole batch; a stuck provider is killed here by
 *  the hard ceiling (see `hardTimeoutMs`) instead of rolling into the next
 *  slice. */
const FORMAT_RETRY_TIMEOUT_MS = 45_000;

/** Total wall-clock ceiling for the whole recovery phase. The isolate-and-retry
 *  phase is bounded TWICE: each single call is hard-capped at its own slice,
 *  and the loop refuses to start another call past this deadline — so a batch
 *  where the provider is down cannot stretch the review by N×45s. Worst case
 *  total for the pass is FORMAT_TIMEOUT_MS + this. */
const FORMAT_RECOVERY_BUDGET_MS = 90_000;

const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });

/** What the model pass actually degraded, for the caller's observability hook.
 *  `polishedByModel + strippedMechanically` can trail `totalSuggestions` — the
 *  remainder were ALREADY prose (Kody Rules findings), ship unchanged and cost
 *  nothing. A non-empty `strippedMechanically` is the only real degradation
 *  signal. */
export interface FormatterDegradedReport {
    totalSuggestions: number;
    polishedByModel: number;
    strippedMechanically: number;
    /** First line of each distinct failure (never suggestion text). */
    distinctReasons: string[];
    organizationId?: string;
    prNumber?: number;
}

export interface FormatSuggestionOptions {
    customWritingGuidelines?: string;
    byokConfig?: NormalizedModel;
    languageResultPrompt?: string;
    organizationId?: string;
    /** Stamped on degradation logs/telemetry so the run is traceable back to a PR. */
    prNumber?: number;
    /** Called once when the batch degraded (at least one suggestion had to be
     *  stripped of WHAT/WHY/HOW locally instead of being polished by the model). */
    onDegraded?: (report: FormatterDegradedReport) => void;
}

/**
 * The floor. Reformats only what it recognises as the review template and
 * returns undefined for anything else — a suggestion that was already prose
 * must not be rearranged by a fallback (see strip-review-scaffolding.ts).
 */
function mechanicalStrip(
    s: SuggestionToFormat,
): FormattedSuggestion | undefined {
    const content = s.suggestionContent || '';
    if (!looksLikeReviewScaffolding(content)) {
        return undefined;
    }
    return {
        suggestionContent: stripReviewScaffolding(content),
        improvedCode: s.improvedCode || '',
    };
}

function resolveLanguageLabel(
    languageResultPrompt?: string,
): string | null {
    if (!languageResultPrompt) {
        return null;
    }
    try {
        return (
            displayNames.of(languageResultPrompt) || languageResultPrompt
        );
    } catch {
        return languageResultPrompt;
    }
}

/**
 * ONE LLM.run attempt on a (sub)set of suggestions. Both the whole batch and an
 * isolated single suggestion go through here so they share the exact same model
 * resolution, reasoning-off switch and timeout contract — the only thing that
 * differs is the scope and the budget.
 */
async function attemptFormat(
    suggestions: SuggestionToFormat[],
    options: FormatSuggestionOptions | undefined,
    langLabel: string | null,
    timeoutMs: number,
): Promise<{ text?: string; error?: Error }> {
    try {
        const text = await LLM.run({
            byokConfig: options?.byokConfig,
            user: buildFormatPrompt(suggestions, {
                customWritingGuidelines: options?.customWritingGuidelines,
                languageLabel: langLabel,
            }),
            runName: 'suggestion-formatter',
            timeoutMs,
            // `timeoutMs` only ABORTS a cooperative provider. Feed the SAME
            // budget as the hard ceiling (`tracedGenerateText`'s
            // `__kodusHardTimeoutMs`) so a provider that ignores the signal is
            // killed here too — without it the wrapper would fall back to its
            // 20-minute call default and the whole "budget" story would be
            // decoration (the exact gap the old FORMAT_RECOVERY_BUDGET_MS had).
            hardTimeoutMs: timeoutMs,
            // Reasoning off. This pass REWRITES PROSE -- it decides nothing, it
            // reformats a finding another model already made -- and production
            // measured the models doing it spending 69-100% of their output
            // tokens on reasoning to get there, which is what put the call on
            // the edge of its own timeout (25 of 86 failures in twelve hours).
            //
            // Provider-agnostic on purpose: the switch resolves to effort
            // 'none' and `buildProviderOptions` owns the per-vendor
            // translation, so no thinking flag is written by hand here.
            suppressReasoning: true,
            // Stamp the org so this pass's usage/cost lands in the org's
            // token-usage view instead of being recorded org-less (dropped).
            organizationId: options?.organizationId,
        });
        return { text };
    } catch (error) {
        return {
            error:
                error instanceof Error
                    ? error
                    : new Error(String(error)),
        };
    }
}

/**
 * Reformat suggestion content from WHAT/WHY/HOW to natural prose,
 * and ensure improvedCode is populated.
 *
 * Plain BYOK text call through the ONE primitive (LLM.run): the passed slot
 * when configured, else the managed default — same model resolution, limiter,
 * reasoning and timeout as every other call. Respects custom writing guidelines
 * if provided.
 *
 * Failure strategy (issue #1763 / #1851): the whole batch gets ONE hard-bounded
 * call; whatever the model could not cover is then re-attempted PER SUGGESTION
 * in isolation (a bad batch response no longer sentences every suggestion to a
 * stripped fallback), each slice hard-capped and the whole recovery phase
 * deadline-bounded. Whatever still failed drops to the deterministic
 * `mechanicalStrip` floor, so no WHAT/WHY/HOW scaffolding ever ships.
 *
 * Prompt + parse live in format-prompt.ts (shared with the format eval).
 */
export async function formatSuggestionContent(
    suggestions: SuggestionToFormat[],
    options?: FormatSuggestionOptions,
): Promise<Map<number, FormattedSuggestion>> {
    if (suggestions.length === 0) {
        return new Map();
    }

    const langLabel = resolveLanguageLabel(options?.languageResultPrompt);

    const out = new Map<number, FormattedSuggestion>();
    const distinctReasons: string[] = [];
    const noteReason = (reason: string) => {
        if (reason && !distinctReasons.includes(reason)) {
            distinctReasons.push(reason);
        }
    };

    // ── whole-batch attempt: one hard-bounded call ──
    const batch = await attemptFormat(
        suggestions,
        options,
        langLabel,
        FORMAT_TIMEOUT_MS,
    );

    let skipRecovery = false;
    if (batch.error) {
        // Classify the SAME way runWithModelFailover does. A TERMINAL cause —
        // suspended account, bad/expired key, unknown model; 55 of the 86
        // production failures in twelve hours — proves every re-request fails
        // the same way, so per-suggestion recovery would just bill N calls to
        // an already-dead tenant. Skip it and go straight to the floor.
        const terminal = isTerminalCategory(
            classifyLLMError(batch.error).category,
        );
        noteReason(batch.error.message);
        if (terminal) {
            skipRecovery = true;
            logger.warn({
                message: `[FORMATTER] Formatting failed (terminal): ${batch.error.message}`,
                context: 'SuggestionFormatter',
                metadata: {
                    organizationId: options?.organizationId,
                    prNumber: options?.prNumber,
                },
            });
        } else {
            logger.warn({
                message: `[FORMATTER] Formatting failed: ${batch.error.message}`,
                context: 'SuggestionFormatter',
                metadata: {
                    organizationId: options?.organizationId,
                    prNumber: options?.prNumber,
                },
            });
        }
    } else {
        const { formatted, parseOk } = parseFormatResponse(batch.text || '');
        if (!parseOk) {
            // Shape, never content. This text is model output ABOUT a customer's
            // code, so a preview of it does not belong in a log store -- the
            // same rule the NUL sanitiser follows when it reports field paths
            // and not values.
            //
            // What the character count alone could not answer: whether the
            // model REFUSED (no bracket anywhere) or answered in a shape the
            // parser could not read (a bracket present, recovery still failed).
            // Those are different problems with different fixes.
            const raw =
                typeof batch.text === 'string' ? batch.text : '';
            logger.warn({
                message: `[FORMATTER] No JSON array in response (${raw.length} chars)`,
                context: 'SuggestionFormatter',
                metadata: {
                    organizationId: options?.organizationId,
                    prNumber: options?.prNumber,
                    chars: raw.length,
                    hasBracket: raw.includes('['),
                    hasFence: raw.includes('```'),
                    startsWith: raw.trimStart().charAt(0) || '(empty)',
                    suggestionCount: suggestions.length,
                },
            });
            noteReason('no JSON array in response');
        } else {
            for (const [i, formattedSuggestion] of formatted) {
                out.set(i, formattedSuggestion);
            }
        }
    }

    const uncovered: number[] = [];
    suggestions.forEach((_, i) => {
        if (!out.has(i)) {
            uncovered.push(i);
        }
    });

    // ── isolate-and-retry: re-polish ONLY what the batch missed ──
    if (uncovered.length > 0 && !skipRecovery) {
        const deadline = Date.now() + FORMAT_RECOVERY_BUDGET_MS;
        for (const i of uncovered) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) {
                noteReason('recovery budget exhausted');
                break;
            }
            const slice = Math.min(FORMAT_RETRY_TIMEOUT_MS, remaining);
            const single = await attemptFormat(
                [suggestions[i]],
                options,
                langLabel,
                slice,
            );
            if (single.error) {
                noteReason(single.error.message);
                // Same proof as the batch branch above: a TERMINAL cause
                // (suspended account, bad/expired key, unknown model — the
                // 55-of-86 production class) fails EVERY re-request, so the
                // remaining per-suggestion calls would only bill an
                // already-dead tenant. Stop the loop; the floor below still
                // de-scaffolds whatever this never polished.
                if (
                    isTerminalCategory(
                        classifyLLMError(single.error).category,
                    )
                ) {
                    noteReason('recovery aborted: terminal batch failure');
                    break;
                }
                continue;
            }
            const { formatted: singleFormatted, parseOk } =
                parseFormatResponse(single.text || '');
            // The isolated prompt contains EXACTLY ONE suggestion, so a single
            // returned entry is about it no matter which index the model echoed
            // — the sub-prompt index 0, or the batch-stable index it "remembers"
            // ({index: 1} for the second suggestion of a two-item batch). Only a
            // lone, real, non-empty answer wins; a multi-item answer is a
            // confusion we must not guess at, and it falls to the floor below.
            const [only] = [...singleFormatted.values()];
            if (
                parseOk &&
                singleFormatted.size === 1 &&
                only &&
                only.suggestionContent.trim().length > 0
            ) {
                out.set(i, only);
            } else {
                noteReason('isolated re-format produced no usable result');
            }
        }
    }

    // ── floor: whatever the model still has not polished must not ship raw ──
    let strippedMechanically = 0;
    suggestions.forEach((s, i) => {
        if (out.has(i)) {
            return;
        }
        const mechanical = mechanicalStrip(s);
        if (mechanical) {
            out.set(i, mechanical);
            strippedMechanically++;
        }
    });

    logger.log({
        message: `[FORMATTER] Formatted ${out.size}/${suggestions.length} suggestions`,
        context: 'SuggestionFormatter',
        // Every other log in this pass stamps the tenant, so an investigator
        // can tie the run back to a PR; keep this one uniform.
        metadata: {
            organizationId: options?.organizationId,
            prNumber: options?.prNumber,
        },
    });

    if (strippedMechanically > 0) {
        const report: FormatterDegradedReport = {
            totalSuggestions: suggestions.length,
            polishedByModel: out.size - strippedMechanically,
            strippedMechanically,
            distinctReasons,
            organizationId: options?.organizationId,
            prNumber: options?.prNumber,
        };
        logger.error({
            message: `[FORMATTER] Degraded: ${strippedMechanically}/${suggestions.length} suggestion(s) stripped of WHAT/WHY/HOW locally because the model pass could not polish them`,
            context: 'SuggestionFormatter',
            metadata: report,
        });
        options?.onDegraded?.(report);
    }

    return out;
}