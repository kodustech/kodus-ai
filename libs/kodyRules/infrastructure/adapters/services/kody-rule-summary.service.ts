import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { createLogger } from '@libs/core/log/logger';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { SubscriptionStatus } from '@libs/ee/license/interfaces/license.interface';
import { byokToVercelModel, getModelName } from '@libs/llm/byok-to-vercel';
import {
    tracedGenerateText,
    timeoutSignal,
    LLM_CALL_TIMEOUT_MS,
} from '@libs/llm/llm-call';
import { buildLangfuseTelemetry } from '@libs/core/log/langfuse';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRulesRepository,
    KODY_RULES_REPOSITORY_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.repository.contract';
import {
    IKodyRule,
    IKodyRuleSummary,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * Structured validation summaries for LONG kody rules.
 *
 * Long rules (walls of CLAUDE.md text) bury the enforceable point; the shard
 * judge's recall tracks how digestible the rule is. Replacing the body of a
 * >1000-char rule with LLM-extracted "WHAT TO VALIDATE / HOW TO VALIDATE"
 * bullets (examples untouched — ruleBlock renders them separately) nearly
 * doubled occurrence-recall on terse models (gpt-5.4-mini 32%→59% avg) with no
 * regression on strong ones (kimi peak 95%, glm stable). Validated on the
 * Rails convention analog cases; see docs/plans/
 * kody-rules-summary-productization.md — including the variants that were
 * tried and REJECTED (examples-first ordering, verdict checklists, a third
 * "when not to flag" section — all reduced recall; don't re-add them).
 *
 * The summary is consumed EXCLUSIVELY by the review path (resolveForReview);
 * UI/sync/export always see the full rule text. `sourceHash` (sha256 of the
 * exact text the summary was generated from) is the correctness guard: rules
 * are written by many call sites, so a hook can be missed — a stale summary is
 * detected by hash mismatch, logged, and never used.
 */

const LONG_RULE_THRESHOLD_CHARS = 1000;
const SUMMARY_CONCURRENCY = 3;

/**
 * Verbatim from the validated experiment (evals/kody-rules/summarize-rules.js,
 * two-section variant). Changing this wording is a measured-regression risk —
 * re-run the analog eval matrix before touching it.
 */
const SUMMARY_SYSTEM_PROMPT = `You convert a long team code-review rule into a compact validation spec. Output EXACTLY two sections in English, plain text, nothing else:

WHAT TO VALIDATE:
- one bullet per concrete, checkable condition a reviewer must flag in a code diff (imperative, specific)

HOW TO VALIDATE:
- one bullet per condition: what pattern/signal in the ADDED lines of a diff indicates a violation

Keep EVERY enforceable requirement from the rule — do not drop rare or edge conditions. Do NOT invent requirements that are not in the rule. Do not include examples (they are provided separately).`;

/**
 * Managed (default) models are trial-only: once the trial ends, an org without
 * its own key must NOT silently consume our managed models — skip generation
 * (the review then uses the full rule text). Mirrors the kody-rules-sync file
 * conversion gate.
 */
const POST_TRIAL_REQUIRES_BYOK = [
    SubscriptionStatus.ACTIVE,
    SubscriptionStatus.PAYMENT_FAILED,
    SubscriptionStatus.CANCELED,
    SubscriptionStatus.EXPIRED,
];

async function mapLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T) => Promise<R>,
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, async () => {
            while (next < items.length) {
                const i = next++;
                out[i] = await fn(items[i]);
            }
        }),
    );
    return out;
}

@Injectable()
export class KodyRuleSummaryService {
    private readonly logger = createLogger(KodyRuleSummaryService.name);

    constructor(
        private readonly permissionValidationService: PermissionValidationService,
        @Inject(KODY_RULES_REPOSITORY_TOKEN)
        private readonly kodyRulesRepository: IKodyRulesRepository,
        // Required: generation runs on the customer's BYOK key — every call
        // MUST emit the usage span so tokens reach the user-facing analytics
        // (same contract as the shard judge's runStructuredReviewCall).
        private readonly observabilityService: ObservabilityService,
    ) {}

    isLong(ruleText: string | undefined | null): boolean {
        return (ruleText ?? '').length > LONG_RULE_THRESHOLD_CHARS;
    }

    hashOf(text: string | undefined | null): string {
        return createHash('sha256')
            .update(text ?? '')
            .digest('hex');
    }

    hasValidSummary(rule: Partial<IKodyRule>): boolean {
        return (
            !!rule.summary?.content &&
            rule.summary.sourceHash === this.hashOf(rule.rule)
        );
    }

    /**
     * Review-path swap: returns a COPY with `rule` replaced by the summary when
     * the rule is long and the summary matches the current text. Any other
     * state returns the rule untouched; a stale summary additionally logs a
     * structured warning so drift is observable in prod.
     */
    resolveForReview(rule: Partial<IKodyRule>): Partial<IKodyRule> {
        if (!this.isLong(rule.rule) || !rule.summary?.content) {
            return rule;
        }
        if (rule.summary.sourceHash !== this.hashOf(rule.rule)) {
            this.logger.warn({
                message:
                    '[kody-rule-summary] stale summary (sourceHash mismatch) — using full rule text; a write path missed regeneration',
                context: KodyRuleSummaryService.name,
                metadata: {
                    ruleUuid: rule.uuid,
                    ruleTitle: rule.title,
                    summaryGeneratedAt: rule.summary.generatedAt,
                },
            });
            return rule;
        }
        return { ...rule, rule: rule.summary.content };
    }

    /**
     * Generate a summary for one long rule. Model policy = the review's: BYOK
     * main when configured; managed default only during trial; post-trial
     * without BYOK generates nothing. Returns null on gate/LLM/shape failure —
     * callers always fall back to the full rule text. No temperature is set:
     * some BYOK models (GLM) reject temperature 0 outright, and a failed call
     * here would permanently pin those orgs to the un-summarized path.
     */
    async generate(
        rule: Partial<IKodyRule>,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<IKodyRuleSummary | null> {
        if (!this.isLong(rule.rule)) {
            return null;
        }
        try {
            const [byokConfig, subscriptionStatus] = await Promise.all([
                this.permissionValidationService.getBYOKConfig(
                    organizationAndTeamData,
                ),
                this.permissionValidationService.getSubscriptionStatus(
                    organizationAndTeamData,
                ),
            ]);

            const hasByok = !!byokConfig?.main;
            if (
                !hasByok &&
                POST_TRIAL_REQUIRES_BYOK.includes(
                    subscriptionStatus as SubscriptionStatus,
                )
            ) {
                this.logger.log({
                    message:
                        '[kody-rule-summary] skipping generation: trial ended and no BYOK configured',
                    context: KodyRuleSummaryService.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        ruleUuid: rule.uuid,
                        subscriptionStatus,
                    },
                });
                return null;
            }

            const model = byokToVercelModel(byokConfig ?? undefined, 'main', {});
            const modelName = getModelName(byokConfig ?? undefined);
            const runName = 'kody-rules.summary-generation';
            // Usage span + Langfuse telemetry: generation may run on the
            // customer's BYOK key, so tokens must reach the user-facing
            // analytics — same wrap the shard judge uses. The timeout keeps a
            // hung provider call from delaying the review (the lazy backfill
            // awaits this before the orchestrator starts).
            const { text } = await this.observabilityService.runAiSdkLLMInSpan({
                spanName: runName,
                runName,
                model: modelName,
                attrs: {
                    organizationId: organizationAndTeamData.organizationId,
                    ruleUuid: rule.uuid,
                },
                exec: () =>
                    tracedGenerateText({
                        model,
                        system: SUMMARY_SYSTEM_PROMPT,
                        prompt: `Rule title: ${rule.title ?? ''}\n\nRule text:\n${rule.rule}`,
                        abortSignal: timeoutSignal(LLM_CALL_TIMEOUT_MS),
                        experimental_telemetry: buildLangfuseTelemetry(
                            runName,
                            {
                                organizationId:
                                    organizationAndTeamData.organizationId,
                            },
                        ),
                    } as any),
            });

            const content = (text ?? '').trim();
            if (
                !/WHAT TO VALIDATE/i.test(content) ||
                !/HOW TO VALIDATE/i.test(content)
            ) {
                this.logger.warn({
                    message:
                        '[kody-rule-summary] generated text missing required sections — discarding',
                    context: KodyRuleSummaryService.name,
                    metadata: {
                        organizationId: organizationAndTeamData.organizationId,
                        ruleUuid: rule.uuid,
                        ruleTitle: rule.title,
                    },
                });
                return null;
            }

            return {
                content,
                sourceHash: this.hashOf(rule.rule),
                generatedAt: new Date(),
                model: modelName,
            };
        } catch (error) {
            this.logger.warn({
                message:
                    '[kody-rule-summary] generation failed — review will use the full rule text',
                context: KodyRuleSummaryService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    ruleUuid: rule.uuid,
                    ruleTitle: rule.title,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
            return null;
        }
    }

    /**
     * Lazy backfill for the review path (covers legacy rules created before
     * this feature): generate + persist summaries for long rules that lack a
     * valid one, then return the rules WITH the fresh summaries attached so
     * the current execution already benefits. Concurrency-limited; every
     * failure degrades to the full rule text — a review is never blocked.
     */
    async ensureSummaries(
        rules: Partial<IKodyRule>[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<Partial<IKodyRule>[]> {
        const pending = rules.filter(
            (r) => r.uuid && this.isLong(r.rule) && !this.hasValidSummary(r),
        );
        if (pending.length === 0) {
            return rules;
        }

        // Doc uuid resolved once — updateRule() addresses the org document,
        // not the org id.
        let docUuid: string | null = null;
        try {
            const doc = await this.kodyRulesRepository.findByOrganizationId(
                organizationAndTeamData.organizationId,
            );
            docUuid = doc?.uuid ?? null;
        } catch (error) {
            this.logger.warn({
                message:
                    '[kody-rule-summary] could not resolve kodyRules doc for persistence — summaries will be used in-memory only',
                context: KodyRuleSummaryService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    error:
                        error instanceof Error ? error.message : String(error),
                },
            });
        }

        const generated = new Map<string, IKodyRuleSummary>();
        await mapLimit(pending, SUMMARY_CONCURRENCY, async (rule) => {
            const summary = await this.generate(rule, organizationAndTeamData);
            if (!summary) {
                return;
            }
            generated.set(rule.uuid!, summary);
            if (docUuid) {
                try {
                    await this.kodyRulesRepository.updateRule(
                        docUuid,
                        rule.uuid!,
                        { summary },
                    );
                } catch (error) {
                    // In-memory summary still serves this execution; the next
                    // review regenerates (idempotent by hash).
                    this.logger.warn({
                        message:
                            '[kody-rule-summary] persist failed — summary used in-memory only for this review',
                        context: KodyRuleSummaryService.name,
                        metadata: {
                            organizationId:
                                organizationAndTeamData.organizationId,
                            ruleUuid: rule.uuid,
                            error:
                                error instanceof Error
                                    ? error.message
                                    : String(error),
                        },
                    });
                }
            }
        });

        if (generated.size > 0) {
            this.logger.log({
                message: `[kody-rule-summary] backfilled ${generated.size}/${pending.length} long-rule summaries`,
                context: KodyRuleSummaryService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    ruleUuids: [...generated.keys()],
                },
            });
        }

        return rules.map((r) =>
            r.uuid && generated.has(r.uuid)
                ? { ...r, summary: generated.get(r.uuid) }
                : r,
        );
    }
}
