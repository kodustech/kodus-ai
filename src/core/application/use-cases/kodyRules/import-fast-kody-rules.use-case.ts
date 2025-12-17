import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { CreateOrUpdateKodyRulesUseCase } from '@/core/application/use-cases/kodyRules/create-or-update.use-case';
import { KodyRulesOrigin, KodyRulesScope, KodyRulesStatus } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { KodyRuleSeverity } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import { ImportFastKodyRulesDto } from '@/core/infrastructure/http/dtos/import-fast-kody-rules.dto';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { Injectable, Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class ImportFastKodyRulesUseCase {
    constructor(
        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,
        private readonly logger: PinoLoggerService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string }; uuid: string; email: string };
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
                const payload = {
                    title: rule.title,
                    rule: rule.rule,
                    path: rule.path,
                    sourcePath: rule.sourcePath,
                    severity:
                        (rule.severity as KodyRuleSeverity) ||
                        KodyRuleSeverity.MEDIUM,
                    scope: rule.scope || KodyRulesScope.FILE,
                    repositoryId: rule.repositoryId,
                    origin: KodyRulesOrigin.USER,
                    status: KodyRulesStatus.ACTIVE,
                    examples: Array.isArray(rule.examples)
                        ? rule.examples
                        : [],
                };

                const created = await this.createOrUpdateKodyRulesUseCase.execute(
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
