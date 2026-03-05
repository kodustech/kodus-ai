import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import {
    CliSessionCaptureModel,
    CliSessionClassificationStatus,
} from './schemas/cli-session-capture.model';
import { CliSessionClassifiedDecision } from '@libs/cli-review/domain/types/cli-session-capture.types';

type CliSessionCaptureDedupLookup = Pick<CliSessionCaptureModel, 'captureId'>;
type CliSessionCaptureForClassification = Pick<
    CliSessionCaptureModel,
    'captureId' | 'event' | 'summary' | 'signals'
>;

@Injectable()
export class CliSessionCaptureRepository {
    constructor(
        @InjectModel(CliSessionCaptureModel.name)
        private readonly cliSessionCaptureModel: Model<CliSessionCaptureModel>,
    ) {}

    async create(
        data: Partial<CliSessionCaptureModel>,
    ): Promise<CliSessionCaptureModel> {
        return this.cliSessionCaptureModel.create(data);
    }

    async findByDedupKey(
        dedupKey: string,
    ): Promise<CliSessionCaptureDedupLookup | null> {
        return this.cliSessionCaptureModel
            .findOne({ dedupKey })
            .select({ captureId: 1, _id: 0 })
            .lean<CliSessionCaptureDedupLookup>()
            .exec();
    }

    async findByCaptureId(
        captureId: string,
    ): Promise<CliSessionCaptureForClassification | null> {
        return this.cliSessionCaptureModel
            .findOne({ captureId })
            .select({
                captureId: 1,
                event: 1,
                summary: 1,
                signals: 1,
                _id: 0,
            })
            .lean<CliSessionCaptureForClassification>()
            .exec();
    }

    async markProcessing(captureId: string): Promise<void> {
        await this.cliSessionCaptureModel
            .updateOne(
                { captureId },
                {
                    $set: {
                        classificationStatus:
                            CliSessionClassificationStatus.PROCESSING,
                        classificationError: null,
                    },
                },
            )
            .exec();
    }

    async markCompleted(
        captureId: string,
        decisions: CliSessionClassifiedDecision[],
        classificationSource: string,
    ): Promise<void> {
        await this.cliSessionCaptureModel
            .updateOne(
                { captureId },
                {
                    $set: {
                        decisions,
                        classificationSource,
                        classifiedAt: new Date(),
                        classificationStatus:
                            CliSessionClassificationStatus.COMPLETED,
                        classificationError: null,
                    },
                },
            )
            .exec();
    }

    async markFailed(captureId: string, errorMessage: string): Promise<void> {
        await this.cliSessionCaptureModel
            .updateOne(
                { captureId },
                {
                    $set: {
                        classificationStatus:
                            CliSessionClassificationStatus.FAILED,
                        classificationError: errorMessage,
                    },
                },
            )
            .exec();
    }

    async markSkipped(captureId: string, reason: string): Promise<void> {
        await this.cliSessionCaptureModel
            .updateOne(
                { captureId },
                {
                    $set: {
                        classificationStatus:
                            CliSessionClassificationStatus.SKIPPED,
                        classificationError: reason,
                        classifiedAt: new Date(),
                    },
                },
            )
            .exec();
    }
}
