import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { ImportFastKodyRulesDto } from '@libs/kodyRules/dtos/import-fast-kody-rules.dto';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { KodyRuleSeverity } from '@libs/ee/kodyRules/dtos/create-kody-rule.dto';
import {
    KodyRulesOrigin,
    KodyRulesScope,
    KodyRulesStatus,
} from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { validateAndScopeIdeRulePath } from '@libs/common/utils/kody-rules/file-patterns';
import { createLogger } from '@kodus/flow';

@Injectable()
export class ImportFastKodyRulesUseCase {
    private readonly logger = createLogger(ImportFastKodyRulesUseCase.name);

    constructor(
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: {
                organization: { uuid: string };
                uuid: string;
                email: string;
            };
        },
    ) {}

    async execute(dto: ImportFastKodyRulesDto) {
        const organizationId = this.request.user?.organization?.uuid;
        if (!organizationId) {
            throw new Error('Organization ID not found');
        }

        const organizationAndTeamData: OrganizationAndTeamData = {
            organizationId,
            teamId: dto.teamId,
        };

        const results: any[] = [];

        for (const rule of dto.rules || []) {
            try {
                // Even though the payload is supposed to be pre-normalised
                // by the client, run it through the same validator the
                // sync flow uses so the persisted shape stays consistent
                // (no IDE-marker leaks, no path === sourcePath rows, no
                // empty paths).
                const validated = rule.sourcePath
                    ? validateAndScopeIdeRulePath({
                          llmPath: rule.path,
                          sourceFilePath: rule.sourcePath,
                          pathSource: (rule as any)?.pathSource,
                      })
                    : { path: rule.path || '**/*', reason: 'accepted-as-is' as const };
                if (validated.reason !== 'accepted-as-is') {
                    this.logger.log({
                        message: `[kody-rules-import-fast] path validation: ${validated.reason}`,
                        context: ImportFastKodyRulesUseCase.name,
                        metadata: {
                            sourceFilePath: rule.sourcePath,
                            originalLlmPath: (validated as any)
                                .originalLlmPath,
                            finalPath: validated.path,
                            pathSource:
                                (rule as any)?.pathSource ?? 'unspecified',
                            repositoryId: rule.repositoryId,
                        },
                    });
                }

                const payload = {
                    title: rule.title,
                    rule: rule.rule,
                    path: validated.path,
                    sourcePath: rule.sourcePath,
                    severity:
                        (rule.severity as KodyRuleSeverity) ||
                        KodyRuleSeverity.MEDIUM,
                    scope: rule.scope || KodyRulesScope.FILE,
                    repositoryId: rule.repositoryId,
                    origin: KodyRulesOrigin.USER,
                    status: KodyRulesStatus.ACTIVE,
                    examples: Array.isArray(rule.examples) ? rule.examples : [],
                };

                const created =
                    await this.createOrUpdateKodyRulesUseCase.execute(
                        payload as any,
                        organizationId,
                        {
                            userId: this.request.user?.uuid || 'kody-system',
                            userEmail:
                                (this.request.user as any)?.email ||
                                'kody@kodus.io',
                        },
                    );

                results.push(created);
            } catch (error) {
                this.logger.error({
                    message: 'Failed to import fast kody rule',
                    context: ImportFastKodyRulesUseCase.name,
                    error,
                    metadata: {
                        ruleTitle: rule?.title,
                        repositoryId: rule?.repositoryId,
                        organizationAndTeamData,
                    },
                });
            }
        }

        return results;
    }
}
