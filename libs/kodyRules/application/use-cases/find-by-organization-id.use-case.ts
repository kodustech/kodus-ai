import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import {
    CONTEXT_REFERENCE_SERVICE_TOKEN,
    IContextReferenceService,
} from '@libs/ai-engine/domain/contextReference/contracts/context-reference.service.contract';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';
import { KodyRulesStatus } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';

import { enrichRulesWithContextReferences } from './utils/enrich-rules-with-context-references.util';

@Injectable()
export class FindByOrganizationIdKodyRulesUseCase {
    private readonly logger = createLogger(
        FindByOrganizationIdKodyRulesUseCase.name,
    );
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(CONTEXT_REFERENCE_SERVICE_TOKEN)
        private readonly contextReferenceService: IContextReferenceService,
    ) {}

    async execute() {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            const existing = await this.kodyRulesService.findByOrganizationId(
                this.request.user.organization.uuid,
            );

            if (!existing) {
                throw new NotFoundException(
                    'No Kody rules found for the given organization ID',
                );
            }

            // Soft-deleted rules stay in the document for audit/history but
            // must not surface on the Kody Rules screen. APPLIED is also
            // hidden to match find-rules-in-organization-by-filter, which is
            // the other listing endpoint the UI uses.
            const visibleRules = (existing.rules || []).filter(
                (rule) =>
                    rule.status !== KodyRulesStatus.DELETED &&
                    rule.status !== KodyRulesStatus.APPLIED,
            );

            const enrichedRulesArray = await enrichRulesWithContextReferences(
                visibleRules,
                this.contextReferenceService,
                this.logger,
            );

            return {
                ...existing,
                rules: enrichedRulesArray,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error finding Kody Rules by organization ID',
                context: FindByOrganizationIdKodyRulesUseCase.name,
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
            throw error;
        }
    }
}
