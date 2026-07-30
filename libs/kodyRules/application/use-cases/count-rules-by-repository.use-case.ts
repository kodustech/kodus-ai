import { Inject, Injectable, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { createLogger } from '@libs/core/log/logger';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

export type KodyRuleRepositoryCount = {
    repositoryId: string;
    directoryId: string | null;
    count: number;
};

/**
 * Returns ACTIVE+PAUSED rule counts per (repository, directory) for the
 * caller's organization, computed in a single aggregation.
 *
 * Replaces the web's previous pattern of calling the per-filter listing
 * endpoint once per repository card — each of those fetched the repo's full
 * embedded rules array AND ran context-reference enrichment, just to read a
 * `.length`. This collapses N heavy requests into one cheap count.
 *
 * Honors the same per-repository read scope as the listing endpoint: a user
 * with a restricted scope only gets counts for repositories they may read
 * (global rules are always allowed).
 */
@Injectable()
export class CountRulesByRepositoryUseCase implements IUseCase {
    private readonly logger = createLogger(CountRulesByRepositoryUseCase.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Optional()
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(): Promise<KodyRuleRepositoryCount[]> {
        const organizationId = this.request?.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        try {
            const counts =
                await this.kodyRulesService.countRulesByRepository(
                    organizationId,
                );

            if (!this.request?.user) {
                return counts;
            }

            const allowedRepoScope =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.KodyRules,
                });

            // null/undefined scope === unrestricted (admin) → return all.
            if (!Array.isArray(allowedRepoScope)) {
                return counts;
            }

            const allowed = new Set([...allowedRepoScope, 'global']);
            return counts.filter(
                (entry) =>
                    !entry.repositoryId || allowed.has(entry.repositoryId),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error counting Kody Rules by repository',
                context: CountRulesByRepositoryUseCase.name,
                error,
                metadata: { organizationId },
            });
            throw error;
        }
    }
}
