import { UserRequest } from '@/config/types/http/user-request.type';
import { KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN } from '@/core/domain/codeBase/contracts/KodyIssuesManagement.contract';
import {
    IIssuesService,
    ISSUES_SERVICE_TOKEN,
} from '@/core/domain/issues/contracts/issues.service.contract';
import { IIssue } from '@/core/domain/issues/interfaces/issues.interface';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@/core/domain/kodyRules/contracts/kodyRules.service.contract';
import {
    Action,
    ResourceType,
} from '@/core/domain/permissions/enums/permissions.enum';
import { IContributingSuggestion } from '@/core/infrastructure/adapters/services/kodyIssuesManagement/domain/kodyIssuesManagement.interface';
import { KodyIssuesManagementService } from '@/core/infrastructure/adapters/services/kodyIssuesManagement/service/kodyIssuesManagement.service';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AuthorizationService } from '@/core/infrastructure/adapters/services/permissions/authorization.service';
import { GetIssuesByFiltersDto } from '@/core/infrastructure/http/dtos/get-issues-by-filters.dto';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

type KodyRuleMetadata = {
    number: string;
    title: string;
};

@Injectable()
export class GetIssuesUseCase implements IUseCase {
    constructor(
        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IIssuesService,

        private readonly logger: PinoLoggerService,

        @Inject(REQUEST)
        private readonly request: UserRequest,

        private readonly cacheService: CacheService,

        private readonly authorizationService: AuthorizationService,

        @Inject(KODY_ISSUES_MANAGEMENT_SERVICE_TOKEN)
        private readonly kodyIssuesManagementService: KodyIssuesManagementService,

        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(filters: GetIssuesByFiltersDto): Promise<IIssue[]> {
        try {
            if (!filters?.organizationId) {
                filters.organizationId = this.request.user.organization.uuid;
            }

            const cacheKey = `issues_${filters.organizationId}`;

            let allIssues =
                await this.cacheService.getFromCache<IIssue[]>(cacheKey);

            if (!allIssues) {
                allIssues = await this.issuesService.find(
                    filters.organizationId,
                );

                if (!allIssues || allIssues?.length === 0) {
                    return [];
                }

                await this.attachKodyRulesMetadata(
                    allIssues,
                    filters.organizationId,
                );

                this.finalizeIssues(allIssues);

                await this.cacheService.addToCache(cacheKey, allIssues, 900000); //15 minutos
            }

            if (!allIssues || allIssues.length === 0) {
                return [];
            }

            const assignedRepositoryIds =
                await this.authorizationService.getRepositoryScope({
                    user: this.request.user,
                    action: Action.Read,
                    resource: ResourceType.Issues,
                });

            if (assignedRepositoryIds !== null) {
                allIssues = allIssues.filter((issue) =>
                    assignedRepositoryIds.includes(issue.repository.id),
                );
            }

            return allIssues;
        } catch (error) {
            this.logger.error({
                context: GetIssuesUseCase.name,
                message: 'Error getting issues',
                error,
                metadata: {
                    organizationId: filters.organizationId,
                    filters,
                },
            });

            return [];
        }
    }

    private finalizeIssues(issues: IIssue[]): IIssue[] {
        for (const issue of issues) {
            const prNumbers = this.selectAllPrNumbers(issue);

            issue.prNumbers = prNumbers.map((prNumber) => prNumber.number);

            delete issue.contributingSuggestions;
        }

        issues.sort(
            (a, b) =>
                new Date(b.createdAt).getTime() -
                new Date(a.createdAt).getTime(),
        );

        return issues;
    }

    private async attachKodyRulesMetadata(
        issues: IIssue[],
        organizationId: string,
    ): Promise<void> {
        const issuesWithKodyRules = issues.filter(
            (issue) =>
                issue.label === LabelType.KODY_RULES &&
                issue.contributingSuggestions?.length,
        );

        if (!issuesWithKodyRules.length) {
            return;
        }

        const metadataCache = new Map<string, KodyRuleMetadata | null>();

        for (const issue of issuesWithKodyRules) {
            try {
                let ruleIds = this.extractKodyRuleIds(
                    issue.contributingSuggestions,
                );

                if (!ruleIds.length) {
                    const enrichedSuggestions =
                        await this.kodyIssuesManagementService.enrichContributingSuggestions(
                            issue.contributingSuggestions,
                            organizationId,
                        );

                    issue.contributingSuggestions = enrichedSuggestions;
                    ruleIds = this.extractKodyRuleIds(enrichedSuggestions);
                }

                if (!ruleIds.length) {
                    continue;
                }

                const metadata = await this.resolveRuleMetadata(
                    ruleIds,
                    metadataCache,
                    organizationId,
                );

                if (metadata) {
                    issue.kodyRule = {
                        number: metadata.number,
                        title: metadata.title,
                    };
                }
            } catch (error) {
                this.logger.warn({
                    context: GetIssuesUseCase.name,
                    message: 'Failed to resolve Kody Rule metadata for issue',
                    error,
                    metadata: {
                        issueId: issue.uuid,
                        organizationId,
                    },
                });
            }
        }
    }

    private extractKodyRuleIds(
        suggestions?: IContributingSuggestion[],
    ): string[] {
        if (!suggestions?.length) {
            return [];
        }

        const ruleIds = new Set<string>();

        suggestions.forEach((suggestion) => {
            suggestion.brokenKodyRulesIds?.forEach((ruleId) => {
                if (ruleId) {
                    ruleIds.add(ruleId);
                }
            });
        });

        return Array.from(ruleIds);
    }

    private async resolveRuleMetadata(
        ruleIds: string[],
        cache: Map<string, KodyRuleMetadata | null>,
        organizationId: string,
    ): Promise<KodyRuleMetadata | null> {
        for (const ruleId of ruleIds) {
            if (!ruleId) {
                continue;
            }

            if (!cache.has(ruleId)) {
                try {
                    const rule = await this.kodyRulesService.findById(ruleId);

                    cache.set(
                        ruleId,
                        rule
                            ? {
                                  number: rule.uuid || ruleId,
                                  title: rule.title,
                              }
                            : null,
                    );
                } catch (error) {
                    this.logger.warn({
                        context: GetIssuesUseCase.name,
                        message: 'Failed to fetch Kody Rule metadata',
                        error,
                        metadata: { ruleId, organizationId },
                    });
                    cache.set(ruleId, null);
                }
            }

            const metadata = cache.get(ruleId);
            if (metadata) {
                return metadata;
            }
        }

        return null;
    }

    private selectAllPrNumbers(issue: IIssue): {
        number: string;
    }[] {
        const prNumbers = new Set<string>();

        if (issue.contributingSuggestions?.length) {
            issue.contributingSuggestions.forEach((suggestion) => {
                if (suggestion.prNumber) {
                    prNumbers.add(suggestion.prNumber.toString());
                }
            });
        }

        const orderedPrNumbers = Array.from(prNumbers).sort(
            (a, b) => parseInt(a) - parseInt(b),
        );

        return orderedPrNumbers.map((prNumber) => ({
            number: prNumber,
        }));
    }
}
