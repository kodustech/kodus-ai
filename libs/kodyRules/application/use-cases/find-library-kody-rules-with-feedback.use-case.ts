import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

import { FindLibraryKodyRulesDto } from '@libs/core/domain/dtos/find-library-kody-rules.dto';
import {
    PaginatedLibraryKodyRulesResponse,
    PaginationMetadata,
} from '@libs/core/domain/dtos/paginated-library-kody-rules.dto';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

@Injectable()
export class FindLibraryKodyRulesWithFeedbackUseCase {
    private readonly logger = createLogger(
        FindLibraryKodyRulesWithFeedbackUseCase.name,
    );
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
        @Inject(REQUEST)
        private readonly request: Request & {
            user?: { uuid: string; organization: { uuid: string } };
        },
    ) {}

    async execute(
        filters: FindLibraryKodyRulesDto,
    ): Promise<PaginatedLibraryKodyRulesResponse> {
        try {
            const { page = 1, limit = 100, skip, ...kodyRuleFilters } = filters;

            // Passa userId se o usuário estiver logado
            const userId = this.request.user?.uuid;

            const allLibraryKodyRules =
                await this.kodyRulesService.getLibraryKodyRulesWithFeedback(
                    kodyRuleFilters,
                    userId,
                );

            // Aplicar paginação
            const totalItems = allLibraryKodyRules.length;
            const totalPages = Math.ceil(totalItems / limit);
            const offset = skip || (page - 1) * limit;
            const paginatedRules = allLibraryKodyRules.slice(
                offset,
                offset + limit,
            );

            const paginationMetadata: PaginationMetadata = {
                currentPage: page,
                totalPages,
                totalItems,
                itemsPerPage: limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1,
            };

            this.logger.log({
                message:
                    'Successfully retrieved library Kody Rules with feedback',
                context: FindLibraryKodyRulesWithFeedbackUseCase.name,
                metadata: {
                    userId,
                    totalItems,
                    page,
                    limit,
                    returnedItems: paginatedRules.length,
                },
            });

            return {
                data: paginatedRules,
                pagination: paginationMetadata,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error finding library Kody Rules with feedback',
                context: FindLibraryKodyRulesWithFeedbackUseCase.name,
                error: error,
            });
            throw error;
        }
    }
}
