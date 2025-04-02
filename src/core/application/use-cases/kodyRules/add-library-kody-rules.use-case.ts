import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { AddLibraryKodyRulesDto } from '@/core/infrastructure/http/dtos/add-library-kody-rules.dto';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { CreateOrUpdateKodyRulesUseCase } from './create-or-update.use-case';
import { CreateKodyRuleDto } from '@/core/infrastructure/http/dtos/create-kody-rule.dto';
import {
    IKodyRule,
    KodyRulesOrigin,
} from '@/core/domain/kodyRules/interfaces/kodyRules.interface';

@Injectable()
export class AddLibraryKodyRulesUseCase {
    constructor(
        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private readonly createOrUpdateKodyRulesUseCase: CreateOrUpdateKodyRulesUseCase,

        private readonly logger: PinoLoggerService,
    ) {}

    async execute(libraryKodyRules: AddLibraryKodyRulesDto) {
        try {
            if (!this.request.user.organization.uuid) {
                throw new Error('Organization ID not found');
            }

            let results: Partial<IKodyRule>[] = [];

            for await (const repoId of libraryKodyRules.repositoriesIds) {
                const kodyRule: CreateKodyRuleDto = {
                    title: libraryKodyRules.title,
                    rule: libraryKodyRules.rule,
                    path: libraryKodyRules.path,
                    severity: libraryKodyRules.severity,
                    repositoryId: repoId,
                    examples: libraryKodyRules.examples,
                    origin: KodyRulesOrigin.LIBRARY,
                };

                const result =
                    await this.createOrUpdateKodyRulesUseCase.execute(
                        kodyRule,
                        this.request.user.organization.uuid,
                    );

                if (!result) {
                    throw new Error('Failed to add library Kody rule');
                }
                results.push(result);
            }

            return results;
        } catch (error) {
            this.logger.error({
                message: 'Could not add library Kody rules',
                context: AddLibraryKodyRulesUseCase.name,
                serviceName: 'AddLibraryKodyRulesUseCase',
                error: error,
                metadata: {
                    libraryKodyRules,
                    organizationAndTeamData: {
                        organizationId: this.request.user.organization.uuid,
                    },
                },
            });
            throw error;
        }
    }
}
