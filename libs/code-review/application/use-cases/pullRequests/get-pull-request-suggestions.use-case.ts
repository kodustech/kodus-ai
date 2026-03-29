import { Inject, Injectable } from '@nestjs/common';
import {
    ISuggestionService,
    SUGGESTION_SERVICE_TOKEN,
} from '@libs/code-review/domain/contracts/SuggestionService.contract';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { DeliveryStatus } from '@libs/platformData/domain/pullRequests/enums/deliveryStatus.enum';

type SuggestionsResponseFormat = 'json' | 'markdown';

@Injectable()
export class GetPullRequestSuggestionsUseCase {
    constructor(
        @Inject(SUGGESTION_SERVICE_TOKEN)
        private readonly suggestionService: ISuggestionService,
    ) {}

    async execute(params: {
        organizationId: string;
        pr: any;
        format: SuggestionsResponseFormat;
        severity?: string;
        category?: string;
    }): Promise<{ response: any; suggestionsCount: number }> {
        const { organizationId, pr, format, severity, category } = params;
        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
        };

        const severityFilter = severity
            ? new Set(
                  severity
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
              )
            : null;
        const categoryFilter = category
            ? new Set(
                  category
                      .split(',')
                      .map((value) => value.trim())
                      .filter(Boolean),
              )
            : null;

        const matchesFilters = (suggestion: any) => {
            const severityMatches = severityFilter
                ? severityFilter.has(suggestion.severity)
                : true;
            const categoryMatches = categoryFilter
                ? categoryFilter.has(suggestion.label)
                : true;

            return severityMatches && categoryMatches;
        };

        const persistedFileSuggestions = (pr.files || []).flatMap((file) =>
            (file.suggestions || [])
                .filter(
                    (suggestion) =>
                        suggestion.deliveryStatus === DeliveryStatus.SENT &&
                        matchesFilters(suggestion),
                )
                .map((suggestion) => ({
                    ...suggestion,
                    filePath: file.path,
                })),
        );

        const platformType = this.resolvePlatformType(pr?.provider);
        const repository = {
            id: pr?.repository?.id,
            name:
                pr?.repository?.name ||
                pr?.repository?.fullName?.split('/')?.pop(),
        };

        const fileSuggestions =
            platformType && repository.id && repository.name
                ? await this.suggestionService.filterActiveReviewSuggestions({
                      organizationAndTeamData,
                      repository,
                      prNumber: pr.number,
                      platformType,
                      suggestions: persistedFileSuggestions,
                  })
                : persistedFileSuggestions;

        const prLevelSuggestions = (pr.prLevelSuggestions || []).filter(
            (suggestion) =>
                suggestion.deliveryStatus === DeliveryStatus.SENT &&
                matchesFilters(suggestion),
        );

        const payload = {
            prNumber: pr.number,
            repositoryId: pr.repository?.id,
            repositoryFullName: pr.repository?.fullName,
            suggestions: {
                files: fileSuggestions,
                prLevel: prLevelSuggestions,
            },
        };

        if (format === 'markdown') {
            return {
                response: {
                    markdown: this.buildMarkdown({
                        payload,
                        severityFilter,
                        categoryFilter,
                    }),
                },
                suggestionsCount:
                    fileSuggestions.length + prLevelSuggestions.length,
            };
        }

        return {
            response: payload,
            suggestionsCount:
                fileSuggestions.length + prLevelSuggestions.length,
        };
    }

    private resolvePlatformType(provider?: string): PlatformType | null {
        const normalizedProvider = provider?.toUpperCase();

        if (
            normalizedProvider &&
            Object.values(PlatformType).includes(
                normalizedProvider as PlatformType,
            )
        ) {
            return normalizedProvider as PlatformType;
        }

        return null;
    }

    private buildMarkdown(params: {
        payload: {
            prNumber: number;
            repositoryId?: string;
            repositoryFullName?: string;
            suggestions: {
                files: any[];
                prLevel: any[];
            };
        };
        severityFilter: Set<string> | null;
        categoryFilter: Set<string> | null;
    }) {
        const { payload, severityFilter, categoryFilter } = params;
        const filtersInfo = [
            severityFilter
                ? `severity in [${[...severityFilter].join(', ')}]`
                : null,
            categoryFilter
                ? `category in [${[...categoryFilter].join(', ')}]`
                : null,
        ]
            .filter(Boolean)
            .join(' | ');

        const filesSection = payload.suggestions.files.length
            ? payload.suggestions.files
                  .map(
                      (suggestion) =>
                          `- [File] ${suggestion.filePath} — ${suggestion.oneSentenceSummary || suggestion.label || ''}\n  - Severity: ${suggestion.severity || ''}\n  - Category: ${suggestion.label || ''}\n  - Status: ${suggestion.deliveryStatus || ''}\n  - Lines: ${suggestion.relevantLinesStart ?? ''}-${suggestion.relevantLinesEnd ?? ''}\n  - Content:\n\n${'```'}\n${suggestion.suggestionContent || suggestion.improvedCode || ''}\n${'```'}`,
                  )
                  .join('\n\n')
            : '_No file-level suggestions sent_';

        const prLevelSection = payload.suggestions.prLevel.length
            ? payload.suggestions.prLevel
                  .map(
                      (suggestion) =>
                          `- [PR] ${suggestion.oneSentenceSummary || suggestion.label || ''}\n  - Severity: ${suggestion.severity || ''}\n  - Category: ${suggestion.label || ''}\n  - Status: ${suggestion.deliveryStatus || ''}\n  - Content:\n\n${'```'}\n${suggestion.suggestionContent || ''}\n${'```'}`,
                  )
                  .join('\n\n')
            : '_No PR-level suggestions sent_';

        return `# Suggestions for PR #${payload.prNumber} (${payload.repositoryFullName || payload.repositoryId || ''})${filtersInfo ? `\n\n_Filters: ${filtersInfo}_` : ''}\n\n## File suggestions\n${filesSection}\n\n## PR-level suggestions\n${prLevelSection}`;
    }
}
