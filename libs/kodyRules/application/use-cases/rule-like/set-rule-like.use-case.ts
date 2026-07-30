import { createLogger } from '@libs/core/log/logger';
import {
    IRuleLikeService,
    RULE_LIKE_SERVICE_TOKEN,
} from '@libs/kodyRules/domain/contracts/ruleLike.service.contract';
import { RuleFeedbackType } from '@libs/kodyRules/domain/entities/ruleLike.entity';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class SetRuleLikeUseCase {
    private readonly logger = createLogger(SetRuleLikeUseCase.name);
    constructor(
        @Inject(RULE_LIKE_SERVICE_TOKEN)
        private readonly ruleLikeService: IRuleLikeService,
    ) {}

    async execute(
        ruleId: string,
        feedback: RuleFeedbackType,
        userId?: string,
    ): Promise<any> {
        try {
            const result = await this.ruleLikeService.setFeedback(
                ruleId,
                feedback,
                userId,
            );

            // Retorna o objeto limpo ao invés da entity
            return result?.toObject() || null;
        } catch (error) {
            this.logger.error({
                message: `Failed to save rule feedback`,
                context: SetRuleLikeUseCase.name,
                error,
                metadata: {
                    ruleId,
                    feedback,
                    userId,
                },
            });
            throw error;
        }
    }
}
