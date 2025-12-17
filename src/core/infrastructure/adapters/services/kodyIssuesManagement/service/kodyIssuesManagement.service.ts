import { Injectable, Inject } from '@nestjs/common';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { PULL_REQUESTS_SERVICE_TOKEN } from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { IPullRequestsService } from '@/core/domain/pullRequests/contracts/pullRequests.service.contracts';
import { ImplementationStatus } from '@/core/domain/pullRequests/enums/implementationStatus.enum';
import { ISSUES_SERVICE_TOKEN } from '@/core/domain/issues/contracts/issues.service.contract';
import { IKodyIssuesManagementService } from '@/core/domain/codeBase/contracts/KodyIssuesManagement.contract';
import { IssuesService } from '@/core/infrastructure/adapters/services/issues/issues.service';
import { KodyIssuesAnalysisService } from '@/ee/codeBase/kodyIssuesAnalysis.service';
import { KODY_ISSUES_ANALYSIS_SERVICE_TOKEN } from '@/ee/codeBase/kodyIssuesAnalysis.service';
import { PriorityStatus } from '@/core/domain/pullRequests/enums/priorityStatus.enum';
import { IssueStatus } from '@/config/types/general/issues.type';
import { CodeSuggestion } from '@/config/types/general/codeReview.type';
import {
    contextToGenerateIssues,
    IContributingSuggestion,
    IRepresentativeSuggestion,
} from '../domain/kodyIssuesManagement.interface';
import {
    IPullRequestManagerService,
    PULL_REQUEST_MANAGER_SERVICE_TOKEN,
} from '@/core/domain/codeBase/contracts/PullRequestManagerService.contract';
import { IssuesEntity } from '@/core/domain/issues/entities/issues.entity';
import { GetIssuesByFiltersDto } from '@/core/infrastructure/http/dtos/get-issues-by-filters.dto';
import { DeliveryStatus } from '@/core/domain/pullRequests/enums/deliveryStatus.enum';
import { ISuggestion } from '@/core/domain/pullRequests/interfaces/pullRequests.interface';
import { LabelType } from '@/shared/utils/codeManagement/labels';
import { SeverityLevel } from '@/shared/utils/enums/severityLevel.enum';
import { CacheService } from '@/shared/utils/cache/cache.service';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { IssueCreationConfig } from '@/core/domain/issues/entities/issue-creation-config.entity';
import { BYOKConfig } from '@kodus/kodus-common/llm';
import { PermissionValidationService } from '@/ee/shared/services/permissionValidation.service';

@Injectable()
export class KodyIssuesManagementService
    implements IKodyIssuesManagementService
{
    constructor(
        private readonly logger: PinoLoggerService,

        @Inject(ISSUES_SERVICE_TOKEN)
        private readonly issuesService: IssuesService,

        @Inject(PULL_REQUESTS_SERVICE_TOKEN)
        private readonly pullRequestsService: IPullRequestsService,

        @Inject(KODY_ISSUES_ANALYSIS_SERVICE_TOKEN)
        private readonly kodyIssuesAnalysisService: KodyIssuesAnalysisService,

        @Inject(PULL_REQUEST_MANAGER_SERVICE_TOKEN)
        private pullRequestHandlerService: IPullRequestManagerService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        private readonly cacheService: CacheService,

        private readonly permissionValidationService: PermissionValidationService,
    ) {}

    async processClosedPr(params: contextToGenerateIssues): Promise<void> {
        try {
            // Validação centralizada de permissões
            const validationResult =
                await this.permissionValidationService.validateExecutionPermissions(
                    params.organizationAndTeamData,
                    undefined, // sem validação de usuário específico
                    KodyIssuesManagementService.name,
                );

            if (!validationResult.allowed) {
                return;
            }

            const byokConfig = validationResult.byokConfig ?? null;

            const issuesConfig = await this.parametersService.findByKey(
                ParametersKey.ISSUE_CREATION_CONFIG,
                params.organizationAndTeamData,
            );

            const issuesConfigValue = issuesConfig?.configValue;

            const shouldAutomaticallyCreateIssues = issuesConfigValue !== false;

            if (shouldAutomaticallyCreateIssues) {
                this.logger.log({
                    message: `Starting issue processing for closed PR#${params.pullRequest.number}`,
                    context: KodyIssuesManagementService.name,
                    metadata: params,
                });

                // 1. Buscar suggestions não implementadas do PR
                const allSuggestions =
                    await this.filterValidSuggestionsFromPrByStatus(
                        params.prFiles,
                    );

                const filteredSuggestions = this.applyIssuesFilters(
                    issuesConfigValue,
                    allSuggestions,
                );

                if (filteredSuggestions.length === 0) {
                    this.logger.log({
                        message: `No suggestions found to create issue for PR#${params.pullRequest.number}`,
                        context: KodyIssuesManagementService.name,
                        metadata: params,
                    });
                }

                // 2. Agrupar por arquivo
                const suggestionsByFile =
                    this.groupSuggestionsByFile(filteredSuggestions);

                // 3. Para cada arquivo, fazer merge com issues existentes
                const changedFiles = Object.keys(suggestionsByFile);

                for (const filePath of changedFiles) {
                    await this.mergeSuggestionsIntoIssues(
                        params,
                        filePath,
                        suggestionsByFile[filePath],
                        byokConfig,
                    );
                }
            } else {
                this.logger.log({
                    message: 'Automatic Issues creation is disabled',
                    context: KodyIssuesManagementService.name,
                    metadata: {
                        pullRequest: params.pullRequest,
                        organizationAndTeamData: params.organizationAndTeamData,
                    },
                });
            }

            // 4. Resolver issues que podem ter sido corrigidas
            await this.resolveExistingIssues(
                params,
                params.prFiles,
                byokConfig,
            );

            await this.pullRequestsService.updateSyncedWithIssuesFlag(
                params.pullRequest.number,
                params.repository.id,
                params.organizationAndTeamData.organizationId,
                true,
            );
        } catch (error) {
            this.logger.error({
                message: `Error processing closed PR#${params.pullRequest.number}`,
                context: KodyIssuesManagementService.name,
                error,
                metadata: params,
            });
            return;
        }
    }

    async mergeSuggestionsIntoIssues(
        context: contextToGenerateIssues,
        filePath: string,
        newSuggestions: any[],
        byokConfig: BYOKConfig | null,
    ): Promise<any> {
        const { organizationAndTeamData, repository, pullRequest } = context;

        try {
            // 1. Buscar issues abertas para o arquivo
            const existingIssues = await this.issuesService.findByFileAndStatus(
                organizationAndTeamData.organizationId,
                repository.id,
                filePath,
                IssueStatus.OPEN,
            );

            if (!existingIssues || existingIssues?.length === 0) {
                // Se não há issues existentes, todas as suggestions são novas
                await this.createNewIssues(context, newSuggestions);
                return;
            }

            // 2. Preparar dados para o prompt (com array de issues)
            const promptData = {
                filePath,
                existingIssues: await Promise.all(
                    existingIssues.map(async (issue) => {
                        const enrichedSuggestions =
                            await this.enrichContributingSuggestions(
                                [issue.contributingSuggestions[0]],
                                organizationAndTeamData.organizationId,
                            );

                        const representativeSuggestion: IRepresentativeSuggestion[] =
                            enrichedSuggestions.map((suggestion) => ({
                                id: suggestion.id,
                                language: suggestion.language,
                                relevantFile: suggestion.relevantFile,
                                suggestionContent: suggestion.suggestionContent,
                                existingCode: suggestion.existingCode,
                                improvedCode: suggestion.improvedCode,
                                oneSentenceSummary:
                                    suggestion.oneSentenceSummary,
                            }));

                        return {
                            issueId: issue.uuid,
                            representativeSuggestion,
                        };
                    }),
                ),
                newSuggestions: newSuggestions.map((suggestion) => ({
                    id: suggestion.id,
                    language: suggestion.language,
                    relevantFile: suggestion.relevantFile,
                    suggestionContent: suggestion.suggestionContent,
                    existingCode: suggestion.existingCode,
                    improvedCode: suggestion.improvedCode,
                    oneSentenceSummary: suggestion.oneSentenceSummary,
                    severity: suggestion.severity,
                    label: suggestion.label,
                })),
            };

            // 3. Chamar LLM para fazer o merge
            const mergeResult =
                await this.kodyIssuesAnalysisService.mergeSuggestionsIntoIssues(
                    organizationAndTeamData,
                    pullRequest,
                    promptData,
                    byokConfig,
                );

            // 4. Processar resultado do merge
            await this.processMergeResult(context, mergeResult, newSuggestions);
        } catch (error) {
            this.logger.error({
                message: `Error merging suggestions into issues for file ${filePath}`,
                context: KodyIssuesManagementService.name,
                error,
                metadata: {
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                    repositoryId: context.repository.id,
                    filePath,
                },
            });
            return;
        }
    }

    async createNewIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        unmatchedSuggestions: Partial<CodeSuggestion>[],
    ): Promise<void> {
        try {
            const pullRequest =
                await this.pullRequestsService.findByNumberAndRepositoryName(
                    context.pullRequest.number,
                    context.repository.name,
                    context.organizationAndTeamData,
                );

            for (const suggestion of unmatchedSuggestions) {
                await this.issuesService.create({
                    title: suggestion.oneSentenceSummary,
                    description: suggestion.suggestionContent,
                    filePath: suggestion.relevantFile,
                    language: suggestion.language,
                    label: suggestion?.label as LabelType,
                    severity: suggestion?.severity as SeverityLevel,
                    contributingSuggestions: [
                        {
                            id: suggestion.id,
                            prNumber: context.pullRequest.number,
                            prAuthor: {
                                id: pullRequest?.user?.id.toString() || '',
                                name: pullRequest?.user?.name || '',
                            },
                            ...(suggestion.brokenKodyRulesIds?.length
                                ? {
                                      brokenKodyRulesIds:
                                          suggestion.brokenKodyRulesIds,
                                  }
                                : {}),
                        },
                    ],
                    repository: {
                        id: context.repository.id,
                        name: context.repository.name,
                        full_name: context.repository.full_name,
                        platform: context.repository.platform,
                    },
                    organizationId:
                        context.organizationAndTeamData.organizationId,
                    status: IssueStatus.OPEN,
                    owner: {
                        gitId: pullRequest.user.id,
                        username: pullRequest.user.username,
                    },
                    reporter: {
                        gitId: 'kodus',
                        username: 'Kodus',
                    },
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                });
            }
        } catch (error) {
            this.logger.error({
                message: 'Error creating new issues',
                context: KodyIssuesManagementService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    prNumber: context.pullRequest.number,
                    repositoryId: context.repository.id,
                },
            });

            return;
        }
    }

    async resolveExistingIssues(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        files: any[],
        byokConfig: BYOKConfig | null,
    ): Promise<void> {
        try {
            if (!files || files?.length === 0) {
                return;
            }

            const prChangedFiles = await this.getChangedFiles(context);

            // Array para coletar todas as promises de atualização
            const updatePromises: Promise<any>[] = [];

            for (const file of files) {
                const currentCode = prChangedFiles.find(
                    (f) => f.filename === file.path,
                )?.fileContent;

                const fileData = files.find((f) => f.path === file.path);
                if (!fileData) continue;

                // Buscar issues abertas para o arquivo
                const openIssues = await this.issuesService.findByFileAndStatus(
                    context.organizationAndTeamData.organizationId,
                    context.repository.id,
                    file.path,
                    IssueStatus.OPEN,
                );

                if (!openIssues?.length) continue;

                if (fileData.status === 'removed') {
                    updatePromises.push(
                        this.issuesService.updateStatusByIds(
                            openIssues.map((issue) => issue.uuid),
                            IssueStatus.DISMISSED,
                        ),
                    );
                    continue;
                }

                const promptData = {
                    filePath: file.path,
                    language: fileData.suggestions?.[0]?.language || 'unknown',
                    currentCode,
                    issues: openIssues.map((issue) => ({
                        issueId: issue.uuid,
                        title: issue.title,
                        description: issue.description,
                        contributingSuggestionIds:
                            issue.contributingSuggestions?.map(
                                (suggestion) => suggestion.id,
                            ),
                    })),
                };

                const llmResult =
                    await this.kodyIssuesAnalysisService.resolveExistingIssues(
                        context,
                        promptData,
                        byokConfig,
                    );

                if (llmResult?.issueVerificationResults) {
                    for (const resolution of llmResult.issueVerificationResults) {
                        if (!resolution.isIssuePresentInCode) {
                            await this.issuesService.updateStatus(
                                resolution.issueId,
                                IssueStatus.RESOLVED,
                            );
                        }
                    }
                }
            }

            // Executar todas as operações de atualização em paralelo
            if (updatePromises.length > 0) {
                await Promise.all(updatePromises);
            }
        } catch (error) {
            this.logger.error({
                message: 'Error resolving existing issues',
                context: KodyIssuesManagementService.name,
                error,
                metadata: {
                    organizationAndTeamData: context.organizationAndTeamData,
                    repositoryId: context.repository.id,
                    prNumber: context.pullRequest.number,
                },
            });

            return;
        }
    }

    private async filterValidSuggestionsFromPrByStatus(
        prFiles: any[],
    ): Promise<any[]> {
        const discardedStatuses = [
            PriorityStatus.DISCARDED_BY_SAFEGUARD,
            PriorityStatus.DISCARDED_BY_KODY_FINE_TUNING,
            PriorityStatus.DISCARDED_BY_CODE_DIFF,
        ];

        return prFiles.reduce((acc: any[], file) => {
            const validSuggestions = (file.suggestions || [])
                .filter((suggestion) => {
                    const isNotImplemented =
                        suggestion.implementationStatus ===
                        ImplementationStatus.NOT_IMPLEMENTED;

                    const isNotDiscarded = !discardedStatuses.includes(
                        suggestion.priorityStatus,
                    );

                    return isNotImplemented && isNotDiscarded;
                })
                .map((suggestion) => ({
                    ...suggestion,
                    relevantFile: file.path,
                }));

            return [...acc, ...validSuggestions];
        }, []);
    }

    private groupSuggestionsByFile(suggestions: Partial<CodeSuggestion>[]) {
        return suggestions.reduce((acc, suggestion) => {
            const filePath = suggestion.relevantFile;
            if (!acc[filePath]) {
                acc[filePath] = [];
            }
            acc[filePath].push(suggestion);
            return acc;
        }, {});
    }

    private async processMergeResult(
        context: Pick<
            contextToGenerateIssues,
            'organizationAndTeamData' | 'repository' | 'pullRequest'
        >,
        mergeResult: any,
        newSuggestions: Partial<CodeSuggestion>[],
    ): Promise<void> {
        if (!mergeResult?.matches) {
            return;
        }

        const unmatchedSuggestions: Partial<CodeSuggestion>[] = [];

        for (const match of mergeResult.matches) {
            const suggestion = newSuggestions.find(
                (s) => s.id === match.suggestionId,
            );

            if (!suggestion) continue;

            if (match.existingIssueId) {
                const existingIssue = await this.issuesService.findById(
                    match.existingIssueId,
                );
                if (existingIssue) {
                    await this.issuesService.addSuggestionIds(
                        match.existingIssueId,
                        [suggestion.id],
                    );
                }
            } else {
                unmatchedSuggestions.push(suggestion);
            }
        }

        if (unmatchedSuggestions.length > 0) {
            await this.createNewIssues(context, unmatchedSuggestions);
        }
    }

    private async getChangedFiles(context: contextToGenerateIssues) {
        const files = await this.pullRequestHandlerService.getChangedFiles(
            context.organizationAndTeamData,
            context.repository,
            context.pullRequest,
            [],
            null,
        );

        return files;
    }

    //#region Auxiliary Functions
    public async ageCalculation(issue: IssuesEntity): Promise<string> {
        const now = new Date();
        const createdAt = new Date(issue.createdAt);

        const diffTime = Math.abs(now.getTime() - createdAt.getTime());
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

        const daysText = diffDays === 1 ? 'day' : 'days';

        return `${diffDays} ${daysText} ago`;
    }

    public async buildFilter(
        filters: GetIssuesByFiltersDto & { repositoryIds?: string[] },
    ): Promise<any> {
        const filter: any = {};

        if (filters.title) {
            filter['title'] = { $regex: filters.title, $options: 'i' };
        }

        const exactMatchFields = [
            'severity',
            'category',
            'organizationId',
            'filePath',
        ];
        exactMatchFields.forEach((field) => {
            if (filters[field]) {
                filter[field] = filters[field];
            }
        });

        if (filters.repositoryName) {
            filter['repository.name'] = {
                $regex: filters.repositoryName,
                $options: 'i',
            };
        }

        if (filters.repositoryIds && filters.repositoryIds) {
            filter['repository.id'] = { $in: filters.repositoryIds };
        }

        if (filters.beforeAt || filters.afterAt) {
            filter['createdAt'] = {};

            if (filters.beforeAt) {
                filter['createdAt'].$lt = new Date(filters.beforeAt);
            }

            if (filters.afterAt) {
                filter['createdAt'].$gt = new Date(filters.afterAt);
            }
        }

        return filter;
    }

    public async getSuggestionByPR(
        organizationId: string,
        prNumber: number,
    ): Promise<ISuggestion[]> {
        const suggestions = await this.pullRequestsService.findSuggestionsByPR(
            organizationId,
            prNumber,
            DeliveryStatus.SENT,
        );

        return suggestions;
    }

    public async enrichContributingSuggestions(
        contributingSuggestions: IContributingSuggestion[],
        organizationId: string,
    ): Promise<IContributingSuggestion[]> {
        const suggestionsCache = new Map<number, ISuggestion[]>();

        const enrichedContributingSuggestions = await Promise.all(
            contributingSuggestions.map(async (contributingSuggestion) => {
                if (
                    typeof contributingSuggestion.prNumber !== 'number' ||
                    Number.isNaN(contributingSuggestion.prNumber)
                ) {
                    return contributingSuggestion;
                }

                try {
                    if (
                        !suggestionsCache.has(
                            contributingSuggestion.prNumber,
                        )
                    ) {
                        const suggestionsFromPR = await this.getSuggestionByPR(
                            organizationId,
                            contributingSuggestion.prNumber,
                        );
                        suggestionsCache.set(
                            contributingSuggestion.prNumber,
                            suggestionsFromPR,
                        );
                    }

                    const suggestionsFromPR =
                        suggestionsCache.get(
                            contributingSuggestion.prNumber,
                        ) || [];

                    const fullSuggestion = suggestionsFromPR.find(
                        (suggestion) =>
                            suggestion.id === contributingSuggestion.id,
                    );

                    if (fullSuggestion) {
                        return {
                            ...contributingSuggestion,
                            existingCode: fullSuggestion.existingCode,
                            improvedCode: fullSuggestion.improvedCode,
                            startLine: fullSuggestion.relevantLinesStart,
                            endLine: fullSuggestion.relevantLinesEnd,
                            oneSentenceSummary:
                                fullSuggestion.oneSentenceSummary,
                            suggestionContent: fullSuggestion.suggestionContent,
                            language: fullSuggestion.language,
                            label: fullSuggestion.label,
                            severity: fullSuggestion.severity,
                            relevantFile: fullSuggestion.relevantFile,
                            brokenKodyRulesIds:
                                fullSuggestion.brokenKodyRulesIds,
                            //prAuthor: fullSuggestion.user.username,
                        };
                    }
                    return contributingSuggestion;
                } catch (error) {
                    return contributingSuggestion;
                }
            }),
        );

        return enrichedContributingSuggestions;
    }

    public async clearIssuesCache(organizationId: string): Promise<void> {
        try {
            const cacheKey = `issues_${organizationId}`;
            await this.cacheService.removeFromCache(cacheKey);

            this.logger.log({
                context: KodyIssuesManagementService.name,
                message: `Cache cleared for organization ${organizationId}`,
                metadata: {
                    organizationId,
                    cacheKey,
                },
            });
        } catch (error) {
            this.logger.error({
                context: KodyIssuesManagementService.name,
                message: `Error clearing cache for organization ${organizationId}`,
                error,
                metadata: {
                    organizationId,
                },
            });
        }
    }

    private applyIssuesFilters(
        issuesConfigValue: IssueCreationConfig,
        allSuggestions: CodeSuggestion[],
    ): CodeSuggestion[] {
        if (!issuesConfigValue) {
            return allSuggestions;
        }

        const { severityFilters, sourceFilters } = issuesConfigValue;

        return allSuggestions.filter((suggestion) => {
            const severity = suggestion?.severity as any;

            if (severityFilters?.minimumSeverity) {
                const order = Object.values(SeverityLevel);
                const idx = order.indexOf(severity);
                const minIdx = order.indexOf(
                    severityFilters.minimumSeverity as any,
                );

                if (idx > minIdx) return false;
            }
            if (
                severityFilters?.allowedSeverities?.length &&
                !severityFilters.allowedSeverities.includes(severity)
            )
                return false;

            if (
                !sourceFilters?.includeCodeReviewEngine &&
                suggestion?.label !== 'kody_rules'
            )
                return false;
            if (
                !sourceFilters?.includeKodyRules &&
                suggestion?.label === 'kody_rules'
            )
                return false;
            return true;
        });
    }
    //#endregion
}
