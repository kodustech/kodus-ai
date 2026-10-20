import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';

import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';
import { CodeAreaRiskMapModel } from '../repositories/schemas/code-area-risk-map.model';

@Injectable()
export class CodeAreaRiskMapService {
    constructor(
        @InjectModel(CodeAreaRiskMapModel.name)
        private readonly model: Model<CodeAreaRiskMapModel>,
    ) {}

    async read(
        organizationId: string,
        repositoryId: string,
    ): Promise<CodeAreaRiskMap | null> {
        const record = await this.model
            .findOne({ organizationId, repositoryId }, { snapshot: 1 })
            .lean()
            .exec();
        return (record?.snapshot as CodeAreaRiskMap | undefined) ?? null;
    }

    async save(
        organizationId: string,
        repositoryId: string,
        snapshot: CodeAreaRiskMap,
    ): Promise<void> {
        await this.model.updateOne(
            { organizationId, repositoryId },
            { $set: { snapshot } },
            { upsert: true },
        );
    }
}
