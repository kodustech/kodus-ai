import { UserRequest } from '@/config/types/http/user-request.type';
import { RemoveRuleLikeUseCase } from '@/core/application/use-cases/rule-like/remove-rule-like.use-case';
import { SetRuleLikeUseCase } from '@/core/application/use-cases/rule-like/set-rule-like.use-case';
import { Body, Controller, Delete, Inject, Param, Post } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { SetRuleFeedbackDto } from '../dtos/set-rule-feedback.dto';

@Controller('rule-like')
export class RuleLikeController {
    constructor(
        private readonly setRuleLikeUseCase: SetRuleLikeUseCase,
        private readonly removeRuleLikeUseCase: RemoveRuleLikeUseCase,

        @Inject(REQUEST)
        private readonly request: UserRequest,
    ) {}

    @Post(':ruleId/feedback')
    async setFeedback(
        @Param('ruleId') ruleId: string,
        @Body() body: SetRuleFeedbackDto,
    ) {
        if (!this.request.user?.uuid) {
            throw new Error('User not authenticated');
        }

        return this.setRuleLikeUseCase.execute(
            ruleId,
            body.feedback,
            this.request.user.uuid,
        );
    }

    @Delete(':ruleId/feedback')
    async removeFeedback(@Param('ruleId') ruleId: string) {
        if (!this.request.user?.uuid) {
            throw new Error('User not authenticated');
        }

        return this.removeRuleLikeUseCase.execute(
            ruleId,
            this.request.user.uuid,
        );
    }
}
