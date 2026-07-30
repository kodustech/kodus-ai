import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import {
    IRuleLikeService,
    RULE_LIKE_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/ruleLike.service.contract';

@Injectable()
export class RemoveRuleLikeUseCase {
    private readonly logger = createLogger(RemoveRuleLikeUseCase.name);
    constructor(
        @Inject(RULE_LIKE_SERVICE_TOKEN)
        private readonly ruleLikeService: IRuleLikeService,
    ) {}

    async execute(ruleId: string, userId?: string): Promise<boolean> {
        if (!userId) {
            throw new Error('userId is required to remove rule like');
        }

        try {
            const result = await this.ruleLikeService.removeFeedback(
                ruleId,
                userId,
            );

            return result;
        } catch (error) {
            this.logger.error({
                message: `Failed to remove rule feedback`,
                context: RemoveRuleLikeUseCase.name,
                error,
                metadata: {
                    ruleId,
                    userId,
                },
            });
            throw error;
        }
    }
}
