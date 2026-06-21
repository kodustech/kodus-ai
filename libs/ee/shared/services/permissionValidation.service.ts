import { BYOKConfig } from '@kodus/kodus-common/llm';
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
import { createLogger } from '@kodus/flow';

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
    byokConfig?: BYOKConfig | null;
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

            this.logger.log({
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

            this.logger.log({
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
                let trialByokConfig: BYOKConfig | null = null;
                let byokLookupFailed = false;

                try {
                    trialByokConfig = await this.getBYOKConfig(
                        organizationAndTeamData,
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
                    validation.trialReviewCreditsRemaining === 0
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
                        metadata: { validation },
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
                            metadata: { validation, consumeResult },
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

            const byokConfig = await this.getBYOKConfig(
                organizationAndTeamData,
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

            this.logger.log({
                message: '@@VALID PERMISSION@@ - Validating basic license',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData },
            });

            const validation =
                await this.licenseService.validateOrganizationLicense(
                    organizationAndTeamData,
                );

            this.logger.log({
                message: '@@VALID PERMISSION@@ - Basic license validated',
                context: contextName || PermissionValidationService.name,
                metadata: { organizationAndTeamData, result: validation },
            });

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
    ): Promise<BYOKConfig | null> {
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

            // Managed plans usam nossas keys
            // if (identifiedPlanType === PlanType.MANAGED) {
            //     this.logger.log({
            //         message: 'Using managed keys for operation',
            //         context: contextName || PermissionValidationService.name,
            //         metadata: {
            //             organizationAndTeamData,
            //             planType: validation?.planType,
            //             identifiedPlanType,
            //         },
            //     });
            //     return null;
            // }

            // Free ou BYOK plans precisam de BYOK config
            const byokConfig = await this.getBYOKConfig(
                organizationAndTeamData,
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
                    provider: byokConfig?.main?.provider,
                    model: byokConfig?.main?.model,
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
     * Retorna a configuração BYOK da organização (se existir).
     *
     * CLI trial requests carry organizationId='trial' (not a UUID) so the
     * organization_parameters lookup would fail with Postgres' UUID syntax
     * check. Treat non-UUID org identifiers as "no BYOK config" instead of
     * letting the query error propagate.
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

        return byokConfig?.configValue || null;
    }
}
