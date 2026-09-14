/**
 * T0 authoring-time compiler (issue #1449). Runs ONCE when a kody-rule is
 * created/edited: asks the LLM to compile the rule into a deterministic
 * detector, runs the compile-time gate, and — only if the gate passes —
 * persists the detector onto the rule. From then on that rule is checked at
 * review time by pure regex (no LLM). Best-effort: any failure leaves the rule
 * semantic, never blocks the save.
 *
 * Model: the customer's BYOK model (self-hosted requirement) with a system
 * fallback. The gate makes model quality safe — a weaker model just yields
 * fewer T0 rules, never a wrong detector.
 */
import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import { LLM } from '@libs/llm/llm';
import { PermissionValidationService } from '@libs/ee/shared/services/permissionValidation.service';
import { ObservabilityService } from '@libs/core/log/observability.service';
import { LLM_TASK } from '@libs/llm/byok-config';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { IKodyRuleDetectorCompiler } from '@libs/kodyRules/domain/contracts/kody-rule-detector-compiler.contract';
import {
    IKodyRule,
    KodyRuleContextNeed,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    compileAttemptIsCurrent,
    contextNeedIsCurrent,
    ruleCompileHash,
    ruleContextNeedHash,
} from '@libs/common/utils/kody-rules/compile-hash';
import {
    compileRuleDetector,
    compilerOutputSchema,
    makeLLMRunCompiler,
    normalizeContextNeed,
    normalizeDetectorExtensions,
    type CompilerOutput,
} from '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler';

@Injectable()
export class KodyRuleDetectorCompilerService
    implements IKodyRuleDetectorCompiler
{
    private readonly logger = createLogger(
        KodyRuleDetectorCompilerService.name,
    );

    constructor(
        private readonly permissionValidationService: PermissionValidationService,
        private readonly observabilityService: ObservabilityService,
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    /**
     * Compile the rule and persist the detector if the gate passes. Clears any
     * stale detector when an edited rule no longer compiles. Swallows errors
     * (the rule simply stays semantic) — this runs fire-and-forget after save.
     */
    async compileAndSave(
        organizationAndTeamData: OrganizationAndTeamData,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
    ): Promise<{
        compiled: boolean;
        declineReason?: string;
        scoped?: boolean;
        contextNeed?: KodyRuleContextNeed;
        fileScope?: string[];
        /** true when an identical rule was already compiled and no call was made. */
        skipped?: boolean;
    }> {
        // Already decided on exactly this text and these examples? Then a
        // second call can only spend the customer's BYOK budget to reach the
        // same verdict. This guard is HERE rather than only in the nightly
        // sweep because it has to hold for every caller — the save hook, MCP,
        // the library import — not just the one that made the cost visible.
        //
        // Note what it does NOT gate on: whether a detector came out. A
        // declined rule is the normal outcome (92,5% of the fleet) and used to
        // look identical to a rule nobody had tried yet, which is what made the
        // sweep re-decide the whole fleet every night, forever.
        // Skipping needs BOTH to be settled. The compile attempt covers the
        // detector; the context need has its own key, versioned by the
        // classifier prompt, and a corrected prompt has to be able to reach a
        // rule nobody edited.
        if (compileAttemptIsCurrent(rule) && contextNeedIsCurrent(rule)) {
            return {
                compiled: !!rule.detector,
                declineReason: rule.compileAttempt?.declineReason,
                scoped: !!rule.detector?.extensions?.length,
                contextNeed: rule.contextNeed?.need,
                fileScope: rule.fileScope?.extensions,
                skipped: true,
            };
        }

        // The context need (issue #1826) rides on THIS call's output — the
        // compiler already reads the whole rule to decide mechanical-vs-
        // semantic, so asking it what the rule must see costs no second round
        // trip. Captured from the raw response because the detector gate below
        // only forwards the detector decision.
        let rawOutput: CompilerOutput | null = null;
        try {
            // native: resolve the kody-rules (codeReview) task to a `{main}`
            // carrier for runStructuredReviewCall. A non-v2/managed/BLOCKED
            // config yields `null` → the managed/env default, exactly as before.
            const taskByok =
                await this.permissionValidationService.resolveTaskSlot(
                    organizationAndTeamData,
                    LLM_TASK.codeReview,
                );

            // Local (Vercel) stack via runStructuredReviewCall — the org's
            // resolved BYOK model or our managed default (kimi-k2.7-code via
            // Moonshot). No LangChain.
            const runCompiler = makeLLMRunCompiler(async ({ system, user }) => {
                const parsed = await LLM.run({
                    byokConfig: taskByok ?? undefined,
                    schema: compilerOutputSchema,
                    system,
                    user,
                    runName: 'kody-rules.detector-compiler',
                    organizationId: organizationAndTeamData.organizationId,
                });
                rawOutput = (parsed as CompilerOutput) ?? null;
                return rawOutput;
            });

            const { detector, declineReason } = await compileRuleDetector(
                rule,
                runCompiler,
                // Marker: a resolved non-managed BYOK slot vs the managed/
                // env-default path (`resolveTaskSlot` returns undefined
                // for a managed/BLOCKED config).
                { modelName: taskByok ? 'byok' : 'system' },
            );

            const orgId = organizationAndTeamData.organizationId;
            const model = taskByok ? 'byok' : 'system';
            // The language scope is saved from the RAW output, before the
            // detector gate — so it lands on semantic rules too. It used to be
            // written only as part of a surviving detector, which meant the
            // 92,5% of the fleet with no detector had no scope at all and were
            // judged against every file in the PR regardless of the language
            // the rule names.
            const [contextNeed, fileScope] = await Promise.all([
                this.saveContextNeed(
                    orgId,
                    ruleUuid,
                    rule,
                    normalizeContextNeed(rawOutput?.contextNeed),
                    model,
                ),
                this.saveFileScope(
                    orgId,
                    ruleUuid,
                    rule,
                    normalizeDetectorExtensions(rawOutput?.extensions),
                    model,
                ),
            ]);

            if (detector) {
                await this.kodyRulesService.updateRuleDetector(
                    orgId,
                    ruleUuid,
                    detector,
                );
                this.logger.log({
                    message: `Compiled T0 detector for rule ${ruleUuid}`,
                    context: KodyRuleDetectorCompilerService.name,
                    metadata: {
                        organizationAndTeamData,
                        ruleUuid,
                        pattern: detector.pattern,
                        extensions: detector.extensions,
                    },
                });
                await this.saveCompileAttempt(orgId, ruleUuid, rule, {
                    outcome: 'compiled',
                    model,
                });
                return {
                    compiled: true,
                    scoped: !!detector.extensions?.length,
                    contextNeed,
                    fileScope,
                };
            }
            // Edited rule that used to be mechanical but no longer is:
            // clear the stale detector so review stops using it.
            if (rule.detector) {
                await this.kodyRulesService.updateRuleDetector(
                    orgId,
                    ruleUuid,
                    null,
                );
            }
            this.logger.log({
                message: `Rule ${ruleUuid} stays semantic (${declineReason})`,
                context: KodyRuleDetectorCompilerService.name,
                metadata: { ruleUuid, declineReason },
            });
            await this.saveCompileAttempt(orgId, ruleUuid, rule, {
                outcome: 'declined',
                declineReason,
                model,
            });
            return { compiled: false, declineReason, contextNeed, fileScope };
        } catch (error) {
            this.logger.warn({
                message: `Detector compile failed for rule ${ruleUuid}; rule stays semantic`,
                context: KodyRuleDetectorCompilerService.name,
                error,
                metadata: { ruleUuid },
            });
            return { compiled: false, declineReason: 'error' };
        }
    }

    /**
     * Store what the rule needs to see (issue #1826), guarded by the rule-text
     * hash so an edited rule cannot keep a stale inference and an unchanged one
     * costs no write.
     *
     * Best-effort in its own try/catch: this runs fire-and-forget after save,
     * and a failure to record the need must never change the detector outcome
     * the caller is waiting on.
     */
    private async saveContextNeed(
        organizationId: string,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
        need: KodyRuleContextNeed,
        model: string,
    ): Promise<KodyRuleContextNeed> {
        // Keyed on the rule text AND the classifier's version, so rewriting
        // the context-need prompt re-asks the fleet once instead of leaving
        // every existing rule frozen on the old prompt's verdict.
        const sourceHash = ruleContextNeedHash(rule);
        const stored = rule.contextNeed;

        // An author outranks the compiler's guess about their own rule, and an
        // unchanged rule text REUSES what is stored — whatever this run inferred.
        // KRC-12 makes the hash the sole trigger for re-inference: keying on the
        // verdict instead let a second, differently-inferred run overwrite a
        // settled need for a rule nobody had edited, so the same text could flip
        // between reviews and take the customer's rule in and out of scope with
        // no author action.
        if (stored?.source === 'author' || stored?.sourceHash === sourceHash) {
            return stored.need;
        }

        try {
            await this.kodyRulesService.updateRuleContextNeed(
                organizationId,
                ruleUuid,
                {
                    need,
                    sourceHash,
                    source: 'compiler',
                    inferredAt: new Date(),
                    model,
                },
            );
        } catch (error) {
            this.logger.warn({
                message: `Could not store the context need for rule ${ruleUuid}; it stays diff-only`,
                context: KodyRuleDetectorCompilerService.name,
                error,
                metadata: { ruleUuid, need },
            });
        }
        return need;
    }

    /**
     * Store the rule's inferred language scope (issue #1826), under exactly the
     * gates `saveContextNeed` uses: the rule-text hash is the sole trigger for
     * re-inference, and an author-set scope outranks the compiler's guess.
     *
     * The hash gate matters more here than for the context need. This value
     * REMOVES files from review, so letting two differently-inferred runs
     * overwrite each other would take a customer's rule in and out of
     * enforcement between reviews with no author action and no visible cause.
     *
     * An empty inference CLEARS a stored scope rather than leaving it: a rule
     * edited to drop the language it named must stop being narrowed by it.
     * Best-effort, in its own try/catch — failing to record a scope must never
     * change the detector outcome the caller is waiting on.
     */
    private async saveFileScope(
        organizationId: string,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
        extensions: string[] | undefined,
        model: string,
    ): Promise<string[] | undefined> {
        const sourceHash = createHash('sha256')
            .update(rule.rule ?? '')
            .digest('hex');
        const stored = rule.fileScope;

        if (stored?.source === 'author' || stored?.sourceHash === sourceHash) {
            return stored.extensions;
        }

        // Nothing inferred and nothing stored: no write, no scope. This is the
        // common case — most rules are genuinely language-agnostic, and an
        // empty list must never be persisted (it would read as "applies to no
        // file kind" instead of "applies to all of them").
        if (!extensions?.length && !stored) return undefined;

        try {
            await this.kodyRulesService.updateRuleFileScope(
                organizationId,
                ruleUuid,
                extensions?.length
                    ? {
                          extensions,
                          sourceHash,
                          source: 'compiler',
                          inferredAt: new Date(),
                          model,
                      }
                    : null,
            );
        } catch (error) {
            this.logger.warn({
                message: `Could not store the file scope for rule ${ruleUuid}; it stays unscoped`,
                context: KodyRuleDetectorCompilerService.name,
                error,
                metadata: { ruleUuid, extensions },
            });
        }
        return extensions;
    }

    /**
     * Remember that we ran, so the nightly sweep stops paying for a verdict it
     * already has.
     *
     * Only called on the two paths that reached a DECISION. An attempt that
     * threw — the model was down, the provider rejected the key, the request
     * timed out — deliberately records nothing, because writing it would freeze
     * that rule out of ever being compiled on the strength of one bad night.
     * The cost of getting this wrong is asymmetric: a missing marker costs one
     * repeated call, a wrong marker costs the rule forever.
     *
     * Best-effort like its siblings: failing to remember must never change the
     * outcome the caller is waiting on. The only consequence is that the rule
     * is tried again, which is exactly today's behavior.
     */
    private async saveCompileAttempt(
        organizationId: string,
        ruleUuid: string,
        rule: Partial<IKodyRule>,
        attempt: {
            outcome: 'compiled' | 'declined';
            declineReason?: string;
            model: string;
        },
    ): Promise<void> {
        try {
            await this.kodyRulesService.updateRuleCompileAttempt(
                organizationId,
                ruleUuid,
                {
                    sourceHash: ruleCompileHash(rule),
                    attemptedAt: new Date(),
                    outcome: attempt.outcome,
                    declineReason: attempt.declineReason,
                    model: attempt.model,
                },
            );
        } catch (error) {
            this.logger.warn({
                message: `Could not record the compile attempt for rule ${ruleUuid}; it will be retried on the next sweep`,
                context: KodyRuleDetectorCompilerService.name,
                error,
                metadata: { ruleUuid, outcome: attempt.outcome },
            });
        }
    }
}
