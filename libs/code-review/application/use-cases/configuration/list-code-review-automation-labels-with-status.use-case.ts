import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { ListCodeReviewAutomationLabelsUseCase } from './list-code-review-automation-labels-use-case';
import { createLogger } from '@libs/core/log/logger';
import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import { CodeReviewVersion } from '@libs/core/infrastructure/config/types/general/codeReview.type';

@Injectable()
export class ListCodeReviewAutomationLabelsWithStatusUseCase {
    private readonly logger = createLogger(
        ListCodeReviewAutomationLabelsWithStatusUseCase.name,
    );

    constructor(
        private readonly listLabelsUseCase: ListCodeReviewAutomationLabelsUseCase,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user?: { organization?: { uuid: string } };
        },
    ) {}

    async execute(params: {
        codeReviewVersion?: CodeReviewVersion;
        teamId?: string;
        repositoryId?: string;
    }) {
        const { codeReviewVersion, teamId, repositoryId } = params || {};

        const labels = this.listLabelsUseCase.execute(codeReviewVersion);

        // Only v2 supports overrides, and only if repo context is provided
        if (
            codeReviewVersion !== CodeReviewVersion.v2 ||
            !teamId ||
            !repositoryId
        ) {
            return { labels };
        }
        const organizationId = this.request?.user?.organization?.uuid;
        const config = await this.codeBaseConfigService.getConfig(
            { organizationId, teamId },
            { name: '', id: repositoryId },
            [],
        );

        try {
            const ov = config?.v2PromptOverrides || {};
            const has = (t?: string) => !!(t && t.trim().length);

            const overridesStatus = {
                categories: {
                    bug: has(ov?.categories?.descriptions?.bug)
                        ? 'custom'
                        : 'default',
                    performance: has(ov?.categories?.descriptions?.performance)
                        ? 'custom'
                        : 'default',
                    security: has(ov?.categories?.descriptions?.security)
                        ? 'custom'
                        : 'default',
                },
                severity: {
                    critical: has(ov?.severity?.flags?.critical)
                        ? 'custom'
                        : 'default',
                    high: has(ov?.severity?.flags?.high) ? 'custom' : 'default',
                    medium: has(ov?.severity?.flags?.medium)
                        ? 'custom'
                        : 'default',
                    low: has(ov?.severity?.flags?.low) ? 'custom' : 'default',
                },
            } as const;

            return { labels, overridesStatus };
        } catch (error) {
            this.logger.warn({
                message:
                    'Failed to enrich labels with overrides status; returning labels only',
                context: ListCodeReviewAutomationLabelsWithStatusUseCase.name,

                error,
                metadata: {
                    organizationAndTeamData: {
                        organizationId,
                        teamId,
                    },
                    repositoryId,
                },
            });
            return { labels };
        }
    }
}
