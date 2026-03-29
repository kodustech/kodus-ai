import { DocumentationItem } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { DocumentationSearchCacheModel } from './schemas/mongoose/documentationSearchCache.model';

type DocumentationSearchCacheLeanResult = Pick<
    DocumentationSearchCacheModel,
    'documentationItem'
>;

@Injectable()
export class DocumentationSearchCacheRepository {
    constructor(
        @InjectModel(DocumentationSearchCacheModel.name)
        private readonly cacheModel: Model<DocumentationSearchCacheModel>,
    ) {}

    async findValidByKey(params: {
        provider: string;
        packageNameNormalized: string;
        queryNormalized: string;
        now: Date;
    }): Promise<DocumentationSearchCacheLeanResult | null> {
        const { provider, packageNameNormalized, queryNormalized, now } =
            params;

        return this.cacheModel
            .findOne({
                provider,
                packageNameNormalized,
                queryNormalized,
                expiresAt: { $gt: now },
            })
            .select({ documentationItem: 1, _id: 0 })
            .lean<DocumentationSearchCacheLeanResult>()
            .exec();
    }

    async upsertByKey(params: {
        provider: string;
        packageNameNormalized: string;
        queryNormalized: string;
        documentationItem: DocumentationItem;
        expiresAt: Date;
    }): Promise<void> {
        const {
            provider,
            packageNameNormalized,
            queryNormalized,
            documentationItem,
            expiresAt,
        } = params;

        await this.cacheModel
            .findOneAndUpdate(
                {
                    provider,
                    packageNameNormalized,
                    queryNormalized,
                },
                {
                    $set: {
                        documentationItem,
                        expiresAt,
                    },
                    $setOnInsert: {
                        provider,
                        packageNameNormalized,
                        queryNormalized,
                    },
                },
                {
                    upsert: true,
                    setDefaultsOnInsert: true,
                },
            )
            .exec();
    }
}
