import { Inject, Injectable, Optional } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { UserRequest } from '@libs/core/infrastructure/config/types/http/user-request.type';
import { createLogger } from '@libs/core/log/logger';
import {
    Action,
    ResourceType,
} from '@libs/identity/domain/permissions/enums/permissions.enum';
import { AuthorizationService } from '@libs/identity/infrastructure/adapters/services/permissions/authorization.service';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import {
    IKodyRuleIndexEntry,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

/**
 * An organization's rules as a picker needs them: id, title and scope, nothing
 * else. `find-rules-in-organization-by-filter` returns whole rules (body,
 * examples, detector, context references) — right for the rules screen, far
 * too much for a search box that only shows titles.
 *
 * Same visibility rules as the full listing: repository scope from the user's
 * permissions, and deleted/applied rules left out.
 */
@Injectable()
export class GetKodyRulesIndexUseCase implements IUseCase {
    private readonly logger = createLogger(GetKodyRulesIndexUseCase.name);

    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,

        @Optional()
        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly authorizationService: AuthorizationService,
    ) {}

    async execute(organizationId: string): Promise<IKodyRuleIndexEntry[]> {
        try {
            const entries =
                await this.kodyRulesService.findRulesIndex(organizationId);

            const visible = entries.filter(
                (entry) =>
                    entry.uuid &&
                    entry.status !== KodyRulesStatus.DELETED &&
                    entry.status !== KodyRulesStatus.APPLIED,
            );

            if (!this.request?.user) {
                return visible;
            }

            const allowedRepoScope =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.KodyRules,
                });

            if (!Array.isArray(allowedRepoScope)) {
                return visible;
            }

            const allowed = new Set([...allowedRepoScope, 'global']);
            return visible.filter(
                (entry) =>
                    !entry.repositoryId || allowed.has(entry.repositoryId),
            );
        } catch (error) {
            this.logger.error({
                message: 'Error building the Kody Rules index',
                context: GetKodyRulesIndexUseCase.name,
                error,
                metadata: { organizationId },
            });
            throw error;
        }
    }
}
