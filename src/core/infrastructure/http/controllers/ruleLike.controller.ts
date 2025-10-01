import {
    Controller,
    Get,
    Post,
    Delete,
    Body,
    Param,
    Query,
    Inject,
    BadRequestException,
} from '@nestjs/common';
import { ProgrammingLanguage } from '@/shared/domain/enums/programming-language.enum';
import { IRuleLikeService } from '@/core/domain/kodyRules/contracts/ruleLike.service.contract';
import { RuleFeedbackType } from '@/core/domain/kodyRules/entities/ruleLike.entity';
import { SetRuleFeedbackDto } from '../dtos/set-rule-feedback.dto';
import { REQUEST } from '@nestjs/core';
import { SetRuleLikeUseCase } from '@/core/application/use-cases/rule-like/set-rule-like.use-case';
import { RemoveRuleLikeUseCase } from '@/core/application/use-cases/rule-like/remove-rule-like.use-case';
import { CountRuleLikesUseCase } from '@/core/application/use-cases/rule-like/count-rule-likes.use-case';
import { GetTopRulesByLanguageUseCase } from '@/core/application/use-cases/rule-like/get-top-rules-by-language.use-case';
import { FindRuleLikesUseCase } from '@/core/application/use-cases/rule-like/find-rule-likes.use-case';
import { GetAllRuleLikesUseCase } from '@/core/application/use-cases/rule-like/get-all-rules-likes.use-case';
import { GetAllRulesWithLikesUseCase } from '@/core/application/use-cases/rule-like/get-all-rules-with-likes.use-case';
import { ICodeBaseConfigService } from '@/ee/codeBase/codeBaseConfig.service.interface';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@/ee/codeBase/codeBaseConfig.service.interface';

@Controller('rule-like')
export class RuleLikeController {
    constructor(
        private readonly setRuleLikeUseCase: SetRuleLikeUseCase,
        private readonly removeRuleLikeUseCase: RemoveRuleLikeUseCase,
        private readonly countRuleLikesUseCase: CountRuleLikesUseCase,
        private readonly getTopRulesByLanguageUseCase: GetTopRulesByLanguageUseCase,
        private readonly findRuleLikesUseCase: FindRuleLikesUseCase,
        private readonly getAllRuleLikesUseCase: GetAllRuleLikesUseCase,
        private readonly getAllRulesWithLikesUseCase: GetAllRulesWithLikesUseCase,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { uuid: string; organization: { uuid: string } };
        },
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    @Post(':ruleId/feedback')
    async setFeedback(
        @Param('ruleId') ruleId: string,
        @Body() body: SetRuleFeedbackDto,
        @Query('repositoryId') repositoryId?: string,
        @Query('repositoryName') repositoryName?: string,
    ) {
        if (!this.request.user?.uuid) {
            throw new Error('User not authenticated');
        }

        // Check if fine-tuning is enabled for this repository
        if (repositoryId && repositoryName) {
            const isFineTuningEnabled = await this.checkFineTuningEnabled(
                repositoryId,
                repositoryName,
            );
            
            if (!isFineTuningEnabled) {
                throw new BadRequestException(
                    'Fine-tuning is disabled for this repository. Feedback cannot be saved.',
                );
            }
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

    @Get(':ruleId/count')
    async countByRule(@Param('ruleId') ruleId: string) {
        return this.countRuleLikesUseCase.execute(ruleId);
    }

    @Get('top')
    async topByLanguage(
        @Query('language') language: ProgrammingLanguage,
        @Query('limit') limit?: number,
    ) {
        return this.getTopRulesByLanguageUseCase.execute(language, limit);
    }

    @Get()
    async find(
        @Query('ruleId') ruleId?: string,
        @Query('userId') userId?: string,
        @Query('language') language?: ProgrammingLanguage,
    ) {
        const filter = {
            ...(ruleId && { ruleId }),
            ...(userId && { userId }),
            ...(language && { language }),
        };
        return this.findRuleLikesUseCase.execute(filter);
    }

    @Get('all')
    async getAllLikes() {
        return this.getAllRuleLikesUseCase.execute();
    }

    @Get('all-rules-with-feedback')
    async getAllRulesWithFeedback() {
        return this.getAllRulesWithLikesUseCase.execute();
    }

    private async checkFineTuningEnabled(
        repositoryId: string,
        repositoryName: string,
    ): Promise<boolean> {
        try {
            const organizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
                teamId: this.request.user.organization.uuid, // Assuming teamId is same as organizationId for now
            };

            const config = await this.codeBaseConfigService.getConfig(
                organizationAndTeamData,
                { id: repositoryId, name: repositoryName },
            );

            return config.kodyFineTuningConfig?.enabled && 
                   config.kodyFineTuningConfig?.fineTuningEnabled;
        } catch (error) {
            // Default to enabled on error to avoid breaking existing functionality
            return true;
        }
    }
}
