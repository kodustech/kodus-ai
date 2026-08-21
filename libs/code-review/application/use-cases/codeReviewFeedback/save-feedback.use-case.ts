import { createLogger } from '@libs/core/log/logger';
import { Inject, Injectable } from '@nestjs/common';

import { CODE_REVIEW_FEEDBACK_SERVICE_TOKEN } from '@libs/code-review/domain/codeReviewFeedback/contracts/codeReviewFeedback.service.contract';
import { ReactionSyncAbortedError } from '@libs/code-review/domain/codeReviewFeedback/errors/reaction-sync-aborted.error';
import { ICollectedReaction } from '@libs/code-review/domain/codeReviewFeedback/interfaces/codeReviewFeedback.interface';
import { CodeReviewFeedbackService } from '@libs/code-review/infrastructure/adapters/services/codeReviewFeedback.service';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { GetReactionsUseCase } from './get-reactions.use-case';

@Injectable()
export class SaveCodeReviewFeedbackUseCase implements IUseCase {
    private readonly logger = createLogger(SaveCodeReviewFeedbackUseCase.name);
    constructor(
        @Inject(CODE_REVIEW_FEEDBACK_SERVICE_TOKEN)
        private readonly codeReviewFeedbackService: CodeReviewFeedbackService,
        private readonly getReactionsUseCase: GetReactionsUseCase,
    ) {}

    /**
     * Returns the reactions actually written this run — new ones plus the ones
     * whose counts moved. The consumer ignores the value; it is here for tests
     * and for reading the logs alongside it.
     */
    async execute(payload: {
        organizationId: string;
        teamId: string;
        automationExecutionsPRs: number[];
    }): Promise<ICollectedReaction[]> {
        try {
            // Contagens já gravadas, para escrever só o que mudou
            const existingFeedbacks =
                await this.codeReviewFeedbackService.getByOrganizationId(
                    payload.organizationId,
                );

            const storedReactions = new Map(
                existingFeedbacks?.map((feedback) => [
                    feedback.suggestionId,
                    feedback.reactions,
                ]) || [],
            );

            let reactions: ICollectedReaction[];
            let abortedError: ReactionSyncAbortedError | undefined;

            try {
                reactions = await this.getReactions(
                    {
                        organizationId: payload.organizationId,
                        teamId: payload.teamId,
                    },
                    payload.automationExecutionsPRs,
                );
            } catch (error) {
                if (!(error instanceof ReactionSyncAbortedError)) {
                    throw error;
                }
                // Salva o que deu tempo de coletar e só então propaga, para o
                // handler reagendar a mensagem sem que a corrida perca tudo.
                reactions = error.partialReactions;
                abortedError = error;
            }

            // O upsert por si só seria idempotente, mas reescrever documento
            // inalterado mexe no updatedAt — que é o cursor de watermark da
            // ingestão de analytics. Escrever só o que mudou evita reingestão
            // diária da organização inteira.
            const changedReactions = reactions.filter((reaction) =>
                this.hasChanged(
                    reaction,
                    storedReactions.get(reaction.suggestionId),
                ),
            );

            this.logger.log({
                message: 'Reaction sync diff',
                context: SaveCodeReviewFeedbackUseCase.name,
                metadata: {
                    organizationId: payload.organizationId,
                    teamId: payload.teamId,
                    totalReactions: reactions.length,
                    storedReactions: storedReactions.size,
                    changedReactions: changedReactions.length,
                    unchangedReactions:
                        reactions.length - changedReactions.length,
                    aborted: !!abortedError,
                },
            });

            if (changedReactions.length > 0) {
                const written =
                    await this.codeReviewFeedbackService.bulkUpsertReactions(
                        changedReactions,
                    );

                this.logger.log({
                    message: 'Reactions written',
                    context: SaveCodeReviewFeedbackUseCase.name,
                    metadata: {
                        organizationId: payload.organizationId,
                        teamId: payload.teamId,
                        attempted: changedReactions.length,
                        // Diverges from `attempted` when a document was already
                        // identical in Mongo despite differing from what we
                        // read — i.e. another run wrote it in between.
                        written,
                    },
                });
            }

            if (abortedError) {
                throw abortedError;
            }

            return changedReactions;
        } catch (error) {
            this.logger.error({
                message: 'Error save code review feedback',
                context: SaveCodeReviewFeedbackUseCase.name,
                error,
                metadata: { payload },
            });
            throw error;
        }
    }

    private async getReactions(
        organizationAndTeamData: OrganizationAndTeamData,
        automationExecutionsPRs: number[],
    ): Promise<ICollectedReaction[]> {
        return this.getReactionsUseCase.execute(
            organizationAndTeamData,
            automationExecutionsPRs,
        );
    }

    private hasChanged(
        reaction: ICollectedReaction,
        stored: ICollectedReaction['reactions'] | undefined,
    ): boolean {
        if (!stored) {
            return true;
        }

        return (
            stored.thumbsUp !== reaction.reactions?.thumbsUp ||
            stored.thumbsDown !== reaction.reactions?.thumbsDown
        );
    }
}
