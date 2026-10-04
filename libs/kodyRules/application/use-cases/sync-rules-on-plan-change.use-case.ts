import { BadRequestException, Inject, Injectable } from '@nestjs/common';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { createLogger } from '@libs/core/log/logger';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

export interface PlanChangedBody {
    organizationId?: string;
    teamId?: string;
    planType?: string;
    subscriptionStatus?: string;
}

/**
 * Reconciles an org's plan-locked Kody Rules right after billing reports a
 * plan change (#1626): upgrades unlock, downgrades re-apply the cap.
 *
 * Best-effort by design: a sync failure is logged and swallowed so billing
 * gets a 200 (it never retries). Reviews still reconcile before running
 * (codeBaseConfig.service.ts) and list reads repair upgrades
 * (KodyRulesService.find).
 */
@Injectable()
export class SyncRulesOnPlanChangeUseCase implements IUseCase {
    private readonly logger = createLogger(SyncRulesOnPlanChangeUseCase.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(body: PlanChangedBody): Promise<void> {
        const organizationId = body?.organizationId;
        if (!organizationId) {
            throw new BadRequestException('Missing organizationId');
        }

        try {
            await this.kodyRulesService.syncRulesWithPlanLimit({
                organizationId,
                teamId: body.teamId,
            });
            this.logger.log({
                message: 'Kody Rules synced after billing plan-changed webhook',
                context: SyncRulesOnPlanChangeUseCase.name,
                metadata: { organizationId },
            });
        } catch (error) {
            this.logger.error({
                message:
                    'Failed to sync Kody Rules after billing plan-changed webhook',
                context: SyncRulesOnPlanChangeUseCase.name,
                error,
                metadata: { organizationId },
            });
        }
    }
}
