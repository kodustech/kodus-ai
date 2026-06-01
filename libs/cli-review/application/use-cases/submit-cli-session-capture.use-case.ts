import { createHash, randomUUID } from 'crypto';
import { createLogger } from '@kodus/flow';
import { Injectable } from '@nestjs/common';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    CliSessionCaptureInput,
    CliSessionCaptureSubmissionResult,
} from '@libs/cli-review/domain/types/cli-session-capture.types';
import { CliSessionCaptureRepository } from '@libs/cli-review/infrastructure/repositories/cli-session-capture.repository';
import { ClassifyCliSessionCaptureUseCase } from './classify-cli-session-capture.use-case';

interface SubmitCliSessionCaptureInput {
    organizationAndTeamData: OrganizationAndTeamData;
    input: CliSessionCaptureInput;
}

@Injectable()
export class SubmitCliSessionCaptureUseCase implements IUseCase {
    private readonly logger = createLogger(SubmitCliSessionCaptureUseCase.name);

    constructor(
        private readonly cliSessionCaptureRepository: CliSessionCaptureRepository,
        private readonly classifyCliSessionCaptureUseCase: ClassifyCliSessionCaptureUseCase,
    ) {}

    async execute(
        params: SubmitCliSessionCaptureInput,
    ): Promise<CliSessionCaptureSubmissionResult> {
        const { organizationAndTeamData, input } = params;
        const capturedAt = new Date(input.capturedAt);
        const capturedAtIso = Number.isNaN(capturedAt.getTime())
            ? input.capturedAt
            : capturedAt.toISOString();

        const dedupKey = this.createDedupKey(
            organizationAndTeamData,
            input,
            capturedAtIso,
        );

        const captureId = this.createCaptureId();

        try {
            await this.cliSessionCaptureRepository.create({
                captureId,
                dedupKey,
                organizationId: organizationAndTeamData.organizationId,
                teamId: organizationAndTeamData.teamId,
                branch: input.branch,
                sha: input.sha,
                orgRepo: input.orgRepo,
                agent: input.agent,
                event: input.event,
                signals: input.signals,
                summary: input.summary,
                capturedAt,
                rawPayload: input as unknown as Record<string, unknown>,
            });

            setImmediate(() => {
                void this.classifyCliSessionCaptureUseCase
                    .execute(captureId)
                    .catch((error) => {
                        this.logger.error({
                            message:
                                'Error running async CLI session capture classification',
                            context: SubmitCliSessionCaptureUseCase.name,
                            error,
                            metadata: { captureId },
                        });
                    });
            });

            return {
                id: captureId,
                accepted: true,
            };
        } catch (error) {
            const err =
                error instanceof Error ? error : new Error(String(error));

            if (this.isDuplicateKeyError(error)) {
                const existing =
                    await this.cliSessionCaptureRepository.findByDedupKey(
                        dedupKey,
                    );

                if (!existing?.captureId) {
                    this.logger.warn({
                        message:
                            'Duplicate CLI session capture detected but existing record could not be resolved',
                        context: SubmitCliSessionCaptureUseCase.name,
                        metadata: {
                            dedupKey,
                            organizationId:
                                organizationAndTeamData.organizationId,
                            teamId: organizationAndTeamData.teamId,
                            branch: input.branch,
                            orgRepo: input.orgRepo,
                        },
                    });

                    throw new Error(
                        'Duplicate CLI session capture detected but existing capture could not be resolved',
                        { cause: error },
                    );
                }

                return {
                    id: existing.captureId,
                    accepted: false,
                };
            }

            this.logger.error({
                message: 'Failed to persist CLI session capture',
                context: SubmitCliSessionCaptureUseCase.name,
                error: err,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    teamId: organizationAndTeamData.teamId,
                    branch: input.branch,
                    orgRepo: input.orgRepo,
                },
            });

            throw error;
        }
    }

    private createDedupKey(
        organizationAndTeamData: OrganizationAndTeamData,
        input: CliSessionCaptureInput,
        capturedAtIso: string,
    ): string {
        const raw = [
            organizationAndTeamData.organizationId,
            organizationAndTeamData.teamId,
            input.branch,
            input.orgRepo || 'null',
            input.sha || 'null',
            input.signals?.sessionId || 'null',
            capturedAtIso,
            input.event,
        ].join('|');

        return createHash('sha256').update(raw).digest('hex');
    }

    private createCaptureId(): string {
        return `cap_${randomUUID().replace(/-/g, '').slice(0, 18)}`;
    }

    private isDuplicateKeyError(error: unknown): boolean {
        return (
            typeof error === 'object' &&
            error !== null &&
            'code' in error &&
            Number((error as { code?: number }).code) === 11000
        );
    }
}
