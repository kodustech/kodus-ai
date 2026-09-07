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
    compileRuleDetector,
    compilerOutputSchema,
    makeLLMRunCompiler,
    normalizeContextNeed,
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
    }> {
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
            const contextNeed = await this.saveContextNeed(
                orgId,
                ruleUuid,
                rule,
                normalizeContextNeed(rawOutput?.contextNeed),
                taskByok ? 'byok' : 'system',
            );

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
                return {
                    compiled: true,
                    scoped: !!detector.extensions?.length,
                    contextNeed,
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
            return { compiled: false, declineReason, contextNeed };
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
        const sourceHash = createHash('sha256')
            .update(rule.rule ?? '')
            .digest('hex');
        const stored = rule.contextNeed;

        // An author outranks the compiler's guess about their own rule, and an
        // unchanged rule text with the same verdict needs no write.
        if (
            stored?.source === 'author' ||
            (stored?.sourceHash === sourceHash && stored.need === need)
        ) {
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
}
