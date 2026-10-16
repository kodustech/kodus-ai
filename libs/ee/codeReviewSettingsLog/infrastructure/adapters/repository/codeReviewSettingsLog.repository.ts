import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';
import { CodeReviewSettingsLogModel } from './schemas/codeReviewSettingsLog.model';
import { ICodeReviewSettingsLogRepository } from '@libs/ee/codeReviewSettingsLog/domain/contracts/codeReviewSettingsLog.repository.contract';
import { ICodeReviewSettingsLog } from '@libs/ee/codeReviewSettingsLog/domain/interfaces/codeReviewSettingsLog.interface';
import { CodeReviewSettingsLogEntity } from '@libs/ee/codeReviewSettingsLog/domain/entities/codeReviewSettingsLog.entity';

@Injectable()
export class CodeReviewSettingsLogRepository implements ICodeReviewSettingsLogRepository {
    constructor(
        @InjectModel(CodeReviewSettingsLogModel.name)
        private readonly codeReviewSettingsLogModel: Model<CodeReviewSettingsLogModel>,
    ) {}

    async create(
        codeReviewSettingsLog: Omit<ICodeReviewSettingsLog, 'uuid'>,
    ): Promise<CodeReviewSettingsLogEntity> {
        const saved = await this.codeReviewSettingsLogModel.create(
            codeReviewSettingsLog,
        );
        return mapSimpleModelToEntity(saved, CodeReviewSettingsLogEntity);
    }

    async find(
        filter?: Partial<ICodeReviewSettingsLog>,
    ): Promise<CodeReviewSettingsLogEntity[]> {
        const query = this.codeReviewSettingsLogModel.find(filter as any);

        query.sort({ createdAt: -1 });

        const codeReviewSettingsLog = await query.exec();

        // The mapper answers an empty result with null; the activity log
        // reads `.length` off it, so an org with no logs (or a filter that
        // matches none) got a 500 instead of an empty page.
        return (
            mapSimpleModelsToEntities<
                CodeReviewSettingsLogModel,
                CodeReviewSettingsLogEntity
            >(codeReviewSettingsLog, CodeReviewSettingsLogEntity) ?? []
        );
    }
}
