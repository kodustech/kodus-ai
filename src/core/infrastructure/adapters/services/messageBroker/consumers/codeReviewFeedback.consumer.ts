import { SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { PinoLoggerService } from '../../logger/pino.service';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable, Inject } from '@nestjs/common';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import { UseFilters } from '@nestjs/common';
import { ICodeBaseConfigService } from '@/ee/codeBase/codeBaseConfig.service.interface';
import { CODE_BASE_CONFIG_SERVICE_TOKEN } from '@/ee/codeBase/codeBaseConfig.service.interface';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class CodeReviewFeedbackConsumer {
    constructor(
        private readonly saveCodeReviewFeedbackUseCase: SaveCodeReviewFeedbackUseCase,
        private readonly logger: PinoLoggerService,
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
    ) {}

    @RabbitSubscribe({
        exchange: 'orchestrator.exchange.delayed',
        routingKey: 'codeReviewFeedback.syncCodeReviewReactions',
        queue: 'codeReviewFeedback.syncCodeReviewReactions.queue',
        allowNonJsonMessages: true,
        queueOptions: {
            deadLetterExchange: 'orchestrator.exchange.dlx',
            deadLetterRoutingKey: 'codeReviewFeedback.syncCodeReviewReactions',
            durable: true,
        },
    })
    async handleSyncCodeReviewReactions(message: any) {
        const payload = message?.payload;

        if (payload) {
            try {
                // Check if fine-tuning is enabled for this repository
                const isFineTuningEnabled = await this.checkFineTuningEnabled(payload);
                
                if (!isFineTuningEnabled) {
                    this.logger.debug({
                        message: `Fine-tuning disabled for repository, skipping feedback processing for team ${payload.teamId}`,
                        context: CodeReviewFeedbackConsumer.name,
                        metadata: {
                            teamId: payload.teamId,
                            organizationId: payload.organizationId,
                            timestamp: new Date().toISOString(),
                        },
                    });
                    return; // Skip processing if fine-tuning is disabled
                }

                await this.saveCodeReviewFeedbackUseCase.execute(payload);
                this.logger.debug({
                    message: `Code review feedback processing for team ${payload.teamId} completed successfully.`,
                    context: CodeReviewFeedbackConsumer.name,
                    metadata: {
                        teamId: payload.teamId,
                        organizationId: payload.organizationId,
                        timestamp: new Date().toISOString(),
                    },
                });
            } catch (error) {
                this.logger.error({
                    message: `Error processing code review feedback for team ${payload.teamId}`,
                    context: CodeReviewFeedbackConsumer.name,
                    error: error.message,
                    metadata: {
                        teamId: payload.teamId,
                        organizationId: payload.organizationId,
                        timestamp: new Date().toISOString(),
                    },
                });

                throw error;
            }
        } else {
            this.logger.error({
                message: 'Message without payload received by the consumer',
                context: CodeReviewFeedbackConsumer.name,
                metadata: {
                    message,
                    timestamp: new Date().toISOString(),
                },
            });

            throw new Error('Invalid message: no payload');
        }
    }

    private async checkFineTuningEnabled(payload: any): Promise<boolean> {
        try {
            // Extract repository information from payload
            // This assumes the payload contains repository information
            // You may need to adjust this based on the actual payload structure
            const repositoryId = payload.repositoryId || payload.repository?.id;
            const repositoryName = payload.repositoryName || payload.repository?.name;
            
            if (!repositoryId || !repositoryName) {
                this.logger.warn({
                    message: 'Repository information not found in payload, defaulting to fine-tuning enabled',
                    context: CodeReviewFeedbackConsumer.name,
                    metadata: { payload },
                });
                return true; // Default to enabled if we can't determine repository
            }

            const organizationAndTeamData = {
                organizationId: payload.organizationId,
                teamId: payload.teamId,
            };

            const config = await this.codeBaseConfigService.getConfig(
                organizationAndTeamData,
                { id: repositoryId, name: repositoryName },
            );

            return config.kodyFineTuningConfig?.enabled && 
                   config.kodyFineTuningConfig?.fineTuningEnabled;
        } catch (error) {
            this.logger.error({
                message: 'Error checking fine-tuning configuration, defaulting to enabled',
                context: CodeReviewFeedbackConsumer.name,
                error: error.message,
                metadata: { payload },
            });
            return true; // Default to enabled on error
        }
    }
}
