import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { BucketInfo } from '@libs/core/infrastructure/config/types/general/kodyRules.type';
import {
    IKodyRulesService,
    KODY_RULES_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/kodyRules.service.contract';

@Injectable()
export class FindLibraryKodyRulesBucketsUseCase {
    private readonly logger = createLogger(
        FindLibraryKodyRulesBucketsUseCase.name,
    );
    constructor(
        @Inject(KODY_RULES_SERVICE_TOKEN)
        private readonly kodyRulesService: IKodyRulesService,
    ) {}

    async execute(): Promise<BucketInfo[]> {
        try {
            const buckets =
                await this.kodyRulesService.getLibraryKodyRulesBuckets();
            return buckets;
        } catch (error) {
            this.logger.error({
                message: 'Error finding library Kody Rules buckets',
                context: FindLibraryKodyRulesBucketsUseCase.name,
                error: error,
            });
            throw error;
        }
    }
}
