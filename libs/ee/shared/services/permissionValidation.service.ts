import type { NormalizedModel } from '@libs/llm/byok-config';
import {
    resolveTaskModel as resolveTaskModelFromConfig,
    resolveTaskSlot as resolveTaskSlotFromConfig,
    type ResolveTaskModelOptions,
    type ResolvedTaskModel,
} from '@libs/llm/resolve-task-model';
import type {
    RequestContext,
    RoutingVerdict,
} from '@libs/llm/routing-strategy';
import {
    hasNonManagedCredential,
    isByokConfig,
    LLM_TASK,
    type BYOKConfig,
    type LlmTask,
} from '@libs/llm/byok-config';
import { Injectable, Inject } from '@nestjs/common';

import { OrganizationParametersKey } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { environment } from '@libs/ee/configs/environment';
import {
    ILicenseService,
    LICENSE_SERVICE_TOKEN,
    OrganizationLicenseValidationResult,
} from '@libs/ee/license/interfaces/license.interface';
import {
    IOrganizationParametersService,
    ORGANIZATION_PARAMETERS_SERVICE_TOKEN,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.service.contract';
import { createLogger } from '@libs/core/log/logger';

export enum PlanType {
    FREE = 'free',
    BYOK = 'byok',
    MANAGED = 'managed',
    TRIAL = 'trial',
}

export enum ValidationErrorType {
    INVALID_LICENSE = 'INVALID_LICENSE',
    USER_NOT_LICENSED = 'USER_NOT_LICENSED',
    BYOK_REQUIRED = 'BYOK_REQUIRED',
    PLAN_LIMIT_EXCEEDED = 'PLAN_LIMIT_EXCEEDED',
    NOT_ERROR = 'NOT_ERROR',
}

export class ValidationError extends Error {
    constructor(
        public type: ValidationErrorType,
        message: string,
        public metadata?: Record<string, any>,
    ) {
        super(message);
        this.name = 'ValidationError';
    }
}

export interface ValidationResult {
    allowed: boolean;
    byokConfig?: NormalizedModel | null;
    errorType?: ValidationErrorType;
    metadata?: Record<string, any>;
    // Subscription status of the org (e.g. 'trial', 'active'). Exposed so
    // downstream consumers (the review pipeline) can pick a trial-specific
    // model without re-validating the license.
    subscriptionStatus?: string;
}

export type ExecutionPermissionValidationOptions = {
    consumeTrialReviewCredit?: boolean;
    trialReviewCreditUsageKey?: string;
};

@Injectable()
export class PermissionValidationService {
    private readonly isCloud: boolean;
    private readonly isDevelopment: boolean;

    private readonly logger = createLogger(PermissionValidationService.name);

    constructor(
        @Inject(LICENSE_SERVICE_TOKEN)
        private readonly licenseService: ILicenseService,
        @Inject(ORGANIZATION_PARAMETERS_SERVICE_TOKEN)
        private readonly organizationParametersService: IOrganizationParametersService,
    ) {
        this.isCloud = environment.API_CLOUD_MODE;
        this.isDevelopment = environment.API_DEVELOPMENT_MODE;
    }

    /**
     * Identifies the plan type robustly
     */
    private identifyPlanType(planType: string | undefined): PlanType | null {
        if (!planType) {
            return null;
        }

        // Normalize to lowercase for comparison
        const normalizedPlan = planType.toLowerCase();

        // Check if it contains specific keywords
        if (normalizedPlan.includes('free')) {
            return PlanType.FREE;
        }
        if (normalizedPlan.includes('byok')) {
            return PlanType.BYOK;
        }
        if (normalizedPlan.includes('managed')) {
            return PlanType.MANAGED;
        }
        if (normalizedPlan.includes('trial')) {
            return PlanType.TRIAL;
        }

        return null;
    }

    /**
     * Verifies if the plan requires BYOK
     */
    private requiresBYOK(planType: PlanType | null): boolean {
        return planType === PlanType.FREE || planType === PlanType.BYOK;
    }

    /**
     * Verifies if the plan requires per-user license validation
     */
    private requiresUserLicense(planType: PlanType | null): boolean {
        return planType === PlanType.BYOK || planType === PlanType.MANAGED;
    }

    /**
     * Unified permission validation for operations that need license + BYOK
     */
    async validateExecutionPermissions(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId?: string,
        contextName?: string,
        options: ExecutionPermissionValidationOptions = {},
    ): Promise<ValidationResult> {
        try {
            // Development mode always allows
            if (this.isDevelopment) {
                return { allowed: true };
            }

            // Self-hosted: check if there's a license to enforce seats
            if (!this.isCloud) {
                return this.validateSelfHostedPermissions(
                    organizationAndTeamData,
                    userGitId,
                    contextName,
                );
            }

            this.logger.debug({
                message:
                    '@@VALID PERMISSION@@ - Validating execution permissions',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData, userGitId },
            });

            // 1. Validate organization license
            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            this.logger.debug({
                message:
                    '@@VALID PERMISSION@@ - Organization license validated',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData, result: validation },
            });

            if (!validation?.valid) {
                this.logger.warn({
                    message: 'Organization license not valid',
                    context: contextName || PermissionValidationService.name,
                    metadata: { organizationAndTeamData, validation },
                });

                return {
                    allowed: false,
                    errorType: ValidationErrorType.INVALID_LICENSE,
                    metadata: { validation },
                };
            }

            // 2. Trial skips user validation, but still honors BYOK and
            // billing-managed review credits when those fields are present.
            if (validation.subscriptionStatus === 'trial') {
                let trialByokConfig: NormalizedModel | null = null;
                let byokLookupFailed = false;

                try {
                    trialByokConfig = await this.resolveTaskSlot(
                        organizationAndTeamData,
                        LLM_TASK.codeReview,
                    );
                } catch (error) {
                    byokLookupFailed = true;
                    this.logger.warn({
                        message:
                            'Could not resolve BYOK config for trial; continuing with managed trial validation',
                        context:
                            contextName || PermissionValidationService.name,
                        metadata: { organizationAndTeamData },
                        error,
                    });
                }

                // Only enforce the credit gate when we're CONFIDENT there's no
                // BYOK. If the lookup threw we can't rule out a connected key,
                // so a user who burned their credits and then connected BYOK
                // must not be blocked by a flaky read — fail open on BYOK.
                const noByok = !trialByokConfig && !byokLookupFailed;

                // Divergence alarm: billing still reports BYOK (its `byok` flag
                // is plan-derived, so a `*_byok` trial keeps it set) while the
                // local config is gone. The two sources never reconcile — the
                // local row is the source of truth for the gate, so we don't
                // trust billing here, but we surface the mismatch so support can
                // find these orgs in observability_logs_ts and reconnect the key.
                if (
                    noByok &&
                    (validation.byok === true ||
                        this.identifyPlanType(validation.planType) ===
                            PlanType.BYOK)
                ) {
                    this.logger.warn({
                        message:
                            'BYOK state divergence: billing reports BYOK but no local config found (trial)',
                        context:
                            contextName || PermissionValidationService.name,
                        metadata: {
                            organizationAndTeamData,
                            billingByok: validation.byok,
                            planType: validation.planType,
                        },
                    });
                }

                // Only trials created under the managed-credit model carry
                // these fields. Legacy trials (started before this shipped)
                // have no credit data — they must keep the old behaviour:
                // unlimited reviews for the full trial, no consumption, no gate.
                const usesTrialCredits =
                    typeof validation.trialReviewCreditsTotal === 'number' ||
                    typeof validation.trialReviewCreditsRemaining === 'number';

                if (
                    usesTrialCredits &&
                    noByok &&
                    // <= 0, not === 0: consumption happens post-delivery, so a
                    // burst of concurrent reviews can over-commit a single
                    // credit and leave the billing counter negative. Blocking
                    // only at exactly 0 would let a negative-balance org keep
                    // running free reviews. `undefined <= 0` is false, so legacy
                    // trials without a remaining value are unaffected.
                    typeof validation.trialReviewCreditsRemaining ===
                        'number' &&
                    validation.trialReviewCreditsRemaining <= 0
                ) {
                    this.logger.warn({
                        message: 'Trial managed review credits exhausted',
                        context:
                            contextName || PermissionValidationService.name,
                        metadata: {
                            organizationAndTeamData,
                            trialReviewCreditsTotal:
                                validation.trialReviewCreditsTotal,
                            trialReviewCreditsUsed:
                                validation.trialReviewCreditsUsed,
                            trialCreditTier: validation.trialCreditTier,
                            trialUnlocks: validation.trialUnlocks,
                        },
                    });

                    return {
                        allowed: false,
                        errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                        // Credits are genuinely gone — safe to tell the user
                        // their trial reviews are used up.
                        metadata: { validation, trialCreditsExhausted: true },
                        subscriptionStatus: validation.subscriptionStatus,
                    };
                }

                if (
                    usesTrialCredits &&
                    noByok &&
                    options.consumeTrialReviewCredit
                ) {
                    const consumeResult =
                        await this.licenseService.consumeTrialReviewCredit(
                            organizationAndTeamData,
                            options.trialReviewCreditUsageKey,
                        );

                    if (!consumeResult.allowed) {
                        this.logger.warn({
                            message: 'Trial review credit consumption denied',
                            context:
                                contextName || PermissionValidationService.name,
                            metadata: {
                                organizationAndTeamData,
                                reason: consumeResult.reason,
                                trialReviewCreditUsageKey:
                                    options.trialReviewCreditUsageKey,
                                consumeResult,
                            },
                        });

                        return {
                            allowed: false,
                            errorType: ValidationErrorType.PLAN_LIMIT_EXCEEDED,
                            metadata: {
                                validation,
                                consumeResult,
                                // Only a billing denial for actually-gone
                                // credits is exhaustion. Match it positively:
                                // billing has other denial reasons (TRIAL_EXPIRED,
                                // LICENSE_NOT_FOUND) and a transport failure
                                // (CONSUME_TRIAL_REVIEW_CREDIT_FAILED), none of
                                // which mean "reviews used up".
                                trialCreditsExhausted:
                                    consumeResult.reason ===
                                    'TRIAL_REVIEW_CREDITS_EXHAUSTED',
                            },
                            subscriptionStatus: validation.subscriptionStatus,
                        };
                    }

                    validation.trialReviewCreditsTotal =
                        consumeResult.trialReviewCreditsTotal ??
                        validation.trialReviewCreditsTotal;
                    validation.trialReviewCreditsUsed =
                        consumeResult.trialReviewCreditsUsed ??
                        validation.trialReviewCreditsUsed;
                    validation.trialReviewCreditsRemaining =
                        consumeResult.trialReviewCreditsRemaining ??
                        validation.trialReviewCreditsRemaining;
                    validation.trialCreditTier =
                        consumeResult.trialCreditTier ??
                        validation.trialCreditTier;
                    validation.trialUnlocks =
                        consumeResult.trialUnlocks ?? validation.trialUnlocks;
                }

                return {
                    allowed: true,
                    byokConfig: trialByokConfig,
                    subscriptionStatus: validation.subscriptionStatus,
                    metadata: {
                        byok: Boolean(trialByokConfig),
                        trialReviewCreditsTotal:
                            validation.trialReviewCreditsTotal,
                        trialReviewCreditsUsed:
                            validation.trialReviewCreditsUsed,
                        trialReviewCreditsRemaining:
                            validation.trialReviewCreditsRemaining,
                        trialCreditTier: validation.trialCreditTier,
                        trialUnlocks: validation.trialUnlocks,
                    },
                };
            }

            // 3. Identify plan type
            const identifiedPlanType = this.identifyPlanType(
                validation.planType,
            );

            const byokConfig = await this.resolveTaskSlot(
                organizationAndTeamData,
                LLM_TASK.codeReview,
            );

            // 4. Managed plans use our keys
            // if (identifiedPlanType === PlanType.MANAGED) {
            //     byokConfig = null; // Uses Kodus keys
            // }
            // 5. Free/BYOK plans need BYOK config (check BEFORE user validation)
            if (this.requiresBYOK(identifiedPlanType)) {
                if (!byokConfig) {
                    this.logger.warn({
                        message: `BYOK required but not configured for plan ${validation.planType}`,
                        context:
                            contextName || PermissionValidationService.name,
                        metadata: {
                            organizationAndTeamData,
                            planType: validation.planType,
                            identifiedPlanType,
                            // Billing keeps a plan-derived `byok` flag that can
                            // stay true after the local key was disconnected;
                            // flag the mismatch so support can spot it.
                            billingByok: validation.byok,
                        },
                    });

                    // Return BYOK error BEFORE user validation
                    return {
                        allowed: false,
                        errorType: ValidationErrorType.BYOK_REQUIRED,
                        metadata: {
                            planType: validation.planType,
                            identifiedPlanType,
                        },
                    };
                }
            }

            if (this.requiresUserLicense(identifiedPlanType) && !userGitId) {
                this.logger.warn({
                    message: 'Plan requires licensed user, NOT_ERROR',
                    context: contextName || PermissionValidationService.name,
                    metadata: { organizationAndTeamData },
                });

                return {
                    allowed: false,
                    errorType: ValidationErrorType.NOT_ERROR,
                    metadata: {
                        reason: 'USER_ID_REQUIRED',
                    },
                };
            }

            // 6. Validate specific user (ALWAYS validates if userGitId provided, except trial and free)
            if (this.requiresUserLicense(identifiedPlanType) && userGitId) {
                const users = await this.licenseService.getAllUsersWithLicense(
                    organizationAndTeamData,
                );

                const user = users?.find((user) => user?.git_id === userGitId);

                if (!user) {
                    this.logger.warn({
                        message: 'User not licensed',
                        context:
                            contextName || PermissionValidationService.name,
                        metadata: { organizationAndTeamData, userGitId },
                    });

                    return {
                        allowed: false,
                        errorType: ValidationErrorType.USER_NOT_LICENSED,
                        metadata: {
                            userGitId,
                            availableUsers: users?.length || 0,
                        },
                    };
                }
            }

            // 7. All OK - return success
            return {
                allowed: true,
                byokConfig,
                subscriptionStatus: validation.subscriptionStatus,
                metadata: { planType: validation.planType, identifiedPlanType },
            };
        } catch (error) {
            // Specific handling for BYOK not configured error
            if (error.message === 'BYOK_NOT_CONFIGURED') {
                return {
                    allowed: false,
                    errorType: ValidationErrorType.BYOK_REQUIRED,
                    metadata: { originalError: error.message },
                };
            }

            this.logger.error({
                message: 'Error validating execution permissions',
                context: contextName || PermissionValidationService.name,
                error,
                metadata: { organizationAndTeamData, userGitId },
            });

            // In case of error, deny access for safety
            return {
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
                metadata: { error: error.message },
            };
        }
    }

    /**
     * Self-hosted permission validation:
     * - No license (Community Edition): allow everything
     * - With license: enforce seat limits and allow auto-assign
     */
    private async validateSelfHostedPermissions(
        organizationAndTeamData: OrganizationAndTeamData,
        userGitId?: string,
        contextName?: string,
    ): Promise<ValidationResult> {
        const validation =
            await this.licenseService.validateOrganizationLicense(
                organizationAndTeamData,
            );

        // No license or invalid → Community Edition, allow everything
        if (!validation?.valid) {
            return { allowed: true };
        }

        // Licensed self-hosted: enforce seat validation
        if (!userGitId) {
            return { allowed: true };
        }

        const users = await this.licenseService.getAllUsersWithLicense(
            organizationAndTeamData,
        );

        const user = users?.find((u) => u?.git_id === userGitId);

        if (!user) {
            this.logger.warn({
                message: 'Self-hosted: user not licensed',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData, userGitId },
            });

            return {
                allowed: false,
                errorType: ValidationErrorType.USER_NOT_LICENSED,
                metadata: {
                    userGitId,
                    availableUsers: users?.length || 0,
                },
            };
        }

        return { allowed: true };
    }

    /**
     * Validação simplificada para operações que só precisam verificar licença
     */
    async validateBasicLicense(
        organizationAndTeamData: OrganizationAndTeamData,
        contextName?: string,
    ): Promise<ValidationResult> {
        try {
            if (this.isDevelopment) {
                return { allowed: true };
            }

            // Self-hosted without license: allow; with license: validate it
            if (!this.isCloud) {
                const validation =
                    await this.licenseService.validateOrganizationLicense(
                        organizationAndTeamData,
                    );
                // CE mode (no license): allow
                if (!validation?.valid) {
                    return { allowed: true };
                }
                return {
                    allowed: true,
                    metadata: { planType: validation.planType },
                };
            }

            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            if (!validation?.valid) {
                this.logger.warn({
                    message: 'Basic license validation failed',
                    context: contextName || PermissionValidationService.name,
                    metadata: { organizationAndTeamData },
                });

                return {
                    allowed: false,
                    errorType: ValidationErrorType.INVALID_LICENSE,
                };
            }

            // Return plan type information for resource limiting logic
            const identifiedPlanType = this.identifyPlanType(
                validation.planType,
            );
            return {
                allowed: true,
                metadata: {
                    planType: validation.planType,
                    identifiedPlanType,
                },
            };
        } catch (error) {
            this.logger.error({
                message: 'Error in basic license validation',
                context: contextName || PermissionValidationService.name,
                error,
                metadata: { organizationAndTeamData },
            });

            return {
                allowed: false,
                errorType: ValidationErrorType.INVALID_LICENSE,
            };
        }
    }

    /**
     * Determina se deve usar configuração BYOK baseado no plano da organização
     * (Consolidado do antigo BYOKDeterminationService)
     */
    async determineBYOKUsage(
        organizationAndTeamData: OrganizationAndTeamData,
        validation: OrganizationLicenseValidationResult,
        contextName?: string,
    ): Promise<NormalizedModel | null> {
        try {
            // Self-hosted sempre usa config das env vars (não usa BYOK)
            if (!this.isCloud) {
                return null;
            }

            if (!validation) {
                return null;
            }

            if (!validation?.valid) {
                return null;
            }

            // Identificar tipo de plano de forma robusta
            const identifiedPlanType = this.identifyPlanType(
                validation?.planType,
            );

            const byokConfig = await this.resolveTaskSlot(
                organizationAndTeamData,
                LLM_TASK.codeReview,
            );

            if (!byokConfig && this.requiresBYOK(identifiedPlanType)) {
                this.logger.warn({
                    message: `BYOK required but not configured for plan ${validation?.planType}`,
                    context: contextName || PermissionValidationService.name,
                    metadata: {
                        organizationAndTeamData,
                        planType: validation?.planType,
                    },
                });

                throw new Error('BYOK_NOT_CONFIGURED');
            }

            this.logger.log({
                message: 'Using BYOK configuration for operation',
                context: contextName || PermissionValidationService.name,
                metadata: {
                    organizationAndTeamData,
                    planType: validation?.planType,
                    provider: byokConfig?.provider,
                    model: byokConfig?.model,
                },
            });

            return byokConfig;
        } catch (error) {
            if (error.message === 'BYOK_NOT_CONFIGURED') {
                throw error; // Re-throw para ser tratado pelo caller
            }

            this.logger.error({
                message: 'Error determining BYOK usage',
                context: contextName || PermissionValidationService.name,
                error: error,
                metadata: { organizationAndTeamData },
            });

            // Em caso de erro, falhar seguramente sem usar BYOK
            return null;
        }
    }

    /**
     * Verifica se os recursos devem ser limitados (plano free)
     * (Consolidado do antigo ValidateLicenseService.limitResources)
     */
    async shouldLimitResources(
        organizationAndTeamData: OrganizationAndTeamData,
        contextName?: string,
    ): Promise<boolean> {
        try {
            // Development mode doesn't limit resources
            if (this.isDevelopment) {
                return false;
            }

            this.logger.log({
                message: '@@VALID PERMISSION@@ - Validating resource limits',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData },
            });

            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            this.logger.log({
                message: '@@VALID PERMISSION@@ - Resource limits validated',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData, result: validation },
            });

            if (!validation?.valid) {
                this.logger.warn({
                    message: `License not active, limiting resources`,
                    context: contextName || PermissionValidationService.name,
                    metadata: {
                        organizationAndTeamData,
                    },
                });

                return true;
            }

            // Self-hosted with valid license: don't limit
            if (
                !this.isCloud &&
                validation.subscriptionStatus === 'licensed-self-hosted'
            ) {
                return false;
            }

            // Self-hosted without license (CE mode): limit resources
            if (!this.isCloud) {
                return true;
            }

            const planType = validation?.planType;
            const limitResources = planType?.includes('free');

            if (limitResources) {
                return true;
            }

            return false;
        } catch (error) {
            this.logger.error({
                message: 'Error checking resource limits',
                context: contextName || PermissionValidationService.name,
                error: error,
            });
            // In case of error, limit resources for safety
            return true;
        }
    }

    /**
     * Resolve the org's BYOK `{main,fallback}` carrier for the `codeReview` task,
     * native (04b-06 — the legacy stored-shape read is GONE). Sources the FULL
     * config blob via `getBYOKConfig` and routes it through `resolveTaskSlot`
     * (StaticTaskStrategy → routed slot + the org's routed fallback), so the
     * credential/model comes from the v2 `models[]`/routing rather than a collapsed
     * legacy `main`. Returns `null` for a non-v2 / absent config or a
     * BLOCKED/unresolvable verdict — the caller then falls to the managed/env
     * default, exactly as with a missing config. Secret hygiene: the returned slot
     * carries ENCRYPTED apiKey ciphertext; this method never decrypts. Non-UUID org
     * ids (CLI trial) resolve to `null` via `getBYOKConfig`.
     */
    /**
     * Single entry point for "give me the routed BYOK carrier for THIS task in
     * THIS org". Reads the org's raw config (getBYOKConfig) and routes it
     * for `task` via the pure resolver — the one place that combines the Nest/DB
     * read with the `@nestjs`-free `libs/llm` resolver, so consumers stop
     * re-implementing the two-step. `null` when there is no BYOK / non-v2 /
     * BLOCKED / non-UUID org → the caller degrades to the managed/env default.
     */
    async resolveTaskSlot(
        organizationAndTeamData: OrganizationAndTeamData,
        task: LlmTask,
        options: { ctx?: RequestContext } = {},
    ): Promise<NormalizedModel | null> {
        const rawConfig = await this.getBYOKConfig(organizationAndTeamData);
        const { slot, verdict } = resolveTaskSlotFromConfig(rawConfig, task, {
            ctx: options.ctx,
        });

        this.logRoutingVerdict(organizationAndTeamData, task, verdict);
        return slot;
    }

    /**
     * Emit the routing decision so a BYOK org's model choice is TRACEABLE — the
     * `verdict` (which tier won, which tiers were skipped and why, whether it fell
     * to the fallback) used to be computed here and thrown away. Logged at the ONE
     * funnel every org-aware consumer passes through, so no call-site threads it.
     *
     * Deliberately quiet on the happy path: a clean primary/default resolution and
     * a no-BYOK org (verdict null) emit nothing — only the events worth tracing do.
     * A BLOCKED verdict on a BYOK org (its config couldn't route → silently on the
     * managed default) is a WARN; a skipped tier / fallback is informational.
     */
    private logRoutingVerdict(
        organizationAndTeamData: OrganizationAndTeamData,
        task: LlmTask,
        verdict: RoutingVerdict | null,
    ): void {
        // No config / non-v2 → nothing to route, nothing to trace.
        if (!verdict) {
            return;
        }
        const blocked = !verdict.modelId;
        const skippedTier = verdict.reason.includes('→');
        const usedFallback = /fallback/i.test(verdict.reason);
        if (!blocked && !skippedTier && !usedFallback) {
            return; // clean primary/default/override resolution — implicit, no noise.
        }

        const metadata = {
            organizationId: organizationAndTeamData?.organizationId,
            teamId: organizationAndTeamData?.teamId,
            task,
            resolvedModelId: verdict.modelId,
            routingReason: verdict.reason, // never carries key material (by contract)
            degradedToManagedDefault: blocked,
            usedFallback,
        };

        if (blocked) {
            this.logger.warn({
                message: `[byok-routing] "${task}" BLOCKED — BYOK org fell back to the managed/env default`,
                context: 'resolveTaskRouting',
                metadata,
            });
        } else {
            this.logger.log({
                message: `[byok-routing] "${task}" → ${verdict.modelId}${usedFallback ? ' (via fallback)' : ''}`,
                context: 'resolveTaskRouting',
                metadata,
            });
        }
    }

    /**
     * Sibling of `resolveTaskCarrier` for consumers that need the BUILT model
     * (not just the carrier): reads the org's raw config and returns the
     * resolved `{ model, modelName, slot, verdict }` for `task`. Same degrade
     * contract — no BYOK → the managed/env default model.
     */
    async resolveTaskModel(
        organizationAndTeamData: OrganizationAndTeamData,
        task: LlmTask,
        options: ResolveTaskModelOptions = {},
    ): Promise<ResolvedTaskModel> {
        const rawConfig = await this.getBYOKConfig(organizationAndTeamData);
        const resolved = resolveTaskModelFromConfig(rawConfig, task, options);
        this.logRoutingVerdict(organizationAndTeamData, task, resolved.verdict);
        return resolved;
    }

    /**
     * "Did this org bring its own key?" — true iff its stored config carries
     * at least one non-managed credential (a managed/env-default credential does
     * NOT count). This is a whole-config question (not per-task), so it reads the
     * raw config blob rather than a resolved carrier — the org-aware companion to the
     * pure `hasNonManagedCredential` helper. Used by the trial gates.
     */
    async hasBYOK(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<boolean> {
        const rawConfig = await this.getBYOKConfig(organizationAndTeamData);
        return hasNonManagedCredential(rawConfig);
    }

    /**
     * Consume ONE managed trial review credit AFTER a review reaches a
     * successful terminal state (the caller gates on SUCCESS / PARTIAL_ERROR).
     *
     * Split from the prerequisites gate on purpose: the gate blocks when
     * credits are exhausted, but consumption must NOT happen up-front — a
     * review that ends in ERROR or SKIPPED should never cost the user a free
     * trial review. Mirrors the same eligibility the gate uses (managed-credit
     * trial + no BYOK); everything else is a no-op. Idempotent per `usageKey`
     * (repo:pr) so retries of the same PR never double-charge.
     *
     * Best-effort: never throws into the caller — a billing hiccup must not
     * fail an already-successful review.
     */
    async consumeTrialReviewCreditOnSuccess(
        organizationAndTeamData: OrganizationAndTeamData,
        usageKey?: string,
    ): Promise<void> {
        try {
            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            if (
                !validation?.valid ||
                validation.subscriptionStatus !== 'trial'
            ) {
                return;
            }

            // Fail CLOSED on BYOK here (opposite of the gate, which fails open):
            // if we can't confirm there's no BYOK, don't consume a managed
            // credit — a BYOK org runs on its own key and owes nothing.
            let byokConfig: BYOKConfig | null = null;
            try {
                byokConfig = await this.getBYOKConfig(organizationAndTeamData);
            } catch {
                return;
            }
            if (byokConfig) {
                return;
            }

            // Only trials created under the managed-credit model carry these
            // fields; legacy trials have none and must not consume.
            const usesTrialCredits =
                typeof validation.trialReviewCreditsTotal === 'number' ||
                typeof validation.trialReviewCreditsRemaining === 'number';
            if (!usesTrialCredits) {
                return;
            }

            const consumeResult =
                await this.licenseService.consumeTrialReviewCredit(
                    organizationAndTeamData,
                    usageKey,
                );

            if (!consumeResult.allowed) {
                this.logger.warn({
                    message:
                        'Post-success trial review credit consumption denied',
                    context: PermissionValidationService.name,
                    metadata: {
                        organizationAndTeamData,
                        usageKey,
                        reason: consumeResult.reason,
                    },
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'consumeTrialReviewCreditOnSuccess failed',
                context: PermissionValidationService.name,
                error,
                metadata: { organizationAndTeamData, usageKey },
            });
        }
    }

    /**
     * Full v2-shape accessor for the routing resolver.
     *
     * `resolveByokCarrier` (above) collapses the stored blob to the routed
     * `{main,fallback}` carrier; this accessor returns the FULL config blob instead —
     * the `models[]`/`routing` the StaticTaskStrategy needs to route PER TASK.
     * Returns `null` for an absent / non-config blob and for a non-UUID org id (CLI
     * trial).
     */
    async getBYOKConfig(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<BYOKConfig | null> {
        const UUID_RE =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(organizationAndTeamData?.organizationId || '')) {
            return null;
        }

        const byokConfig = await this.organizationParametersService.findByKey(
            OrganizationParametersKey.BYOK_CONFIG,
            organizationAndTeamData,
        );

        const raw = byokConfig?.configValue;
        return isByokConfig(raw) ? raw : null;
    }

    /**
     * Returns the org's current subscription status (e.g. 'trial', 'active').
     * Used by non-review flows (kody-rules, config detection) to mirror the
     * code review pipeline's trial-only defaults for helper LLM calls.
     * Non-UUID org ids (CLI trial requests) and errors resolve to undefined.
     */
    async getSubscriptionStatus(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string | undefined> {
        const UUID_RE =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        if (!UUID_RE.test(organizationAndTeamData?.organizationId || '')) {
            return undefined;
        }

        try {
            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );
            return validation?.subscriptionStatus;
        } catch {
            return undefined;
        }
    }

    /**
     * Access tier for the global Kody Rules import feature:
     *   - `free`  → blocked (no valid license, or an explicit Free plan);
     *   - `trial` → capped (see GLOBAL_RULES_TRIAL_IMPORT_LIMIT);
     *   - `paid`  → unlimited (any other valid plan).
     *
     * The sync engine and the web UI both resolve access through this single
     * method so enforcement and the on-screen state can never disagree. Cloud
     * and self-hosted are treated identically: a valid, non-trial, non-free
     * license (including a `licensed-self-hosted` key) is `paid`, and an
     * unlicensed install (self-hosted CE / an expired or missing key) is `free`
     * — matching how `shouldLimitResources` already treats unlicensed installs.
     * Fails closed to `free` on a license lookup error.
     */
    async resolveGlobalRulesImportTier(
        organizationAndTeamData: OrganizationAndTeamData,
        contextName?: string,
    ): Promise<'free' | 'trial' | 'paid'> {
        // Dev-only override so the free/trial/paid UI can be exercised locally
        // (where an install usually has no license and would resolve to free).
        // Never honored outside development mode.
        if (this.isDevelopment) {
            const override = process.env.GLOBAL_RULES_IMPORT_TIER_OVERRIDE;
            if (
                override === 'free' ||
                override === 'trial' ||
                override === 'paid'
            ) {
                return override;
            }
        }

        try {
            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            // No valid license (cloud Free, or self-hosted without an
            // activation key / expired) → feature blocked.
            if (!validation?.valid) {
                return 'free';
            }

            if (validation.subscriptionStatus === 'trial') {
                return 'trial';
            }

            if (this.identifyPlanType(validation.planType) === PlanType.FREE) {
                return 'free';
            }

            // Any other valid plan, including a licensed self-hosted key.
            return 'paid';
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to resolve global rules import tier; defaulting to free',
                context: contextName || PermissionValidationService.name,
                error,
                metadata: { organizationAndTeamData },
            });
            return 'free';
        }
    }
}
