import { SaveCodeReviewFeedbackUseCase } from '@/core/application/use-cases/codeReviewFeedback/save-feedback.use-case';
import { PinoLoggerService } from '../../logger/pino.service';
import { RabbitSubscribe } from '@golevelup/nestjs-rabbitmq';
import { Injectable } from '@nestjs/common';
import { RabbitmqConsumeErrorFilter } from '@/shared/infrastructure/filters/rabbitmq-consume-error.exception';
import { UseFilters } from '@nestjs/common';

@UseFilters(RabbitmqConsumeErrorFilter)
@Injectable()
export class CodeReviewFeedbackConsumer {
    constructor(
        private readonly saveCodeReviewFeedbackUseCase: SaveCodeReviewFeedbackUseCase,
        private readonly logger: PinoLoggerService,
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
}
