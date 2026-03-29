import { DocumentationItem } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { CoreDocument } from '@libs/core/infrastructure/repositories/model/mongodb';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'documentationSearchCache',
    timestamps: true,
    autoIndex: true,
})
export class DocumentationSearchCacheModel extends CoreDocument {
    @Prop({ type: String, required: true })
    provider: string;

    @Prop({ type: String, required: true })
    packageNameNormalized: string;

    @Prop({ type: String, required: true })
    queryNormalized: string;

    @Prop({ type: Object, required: true })
    documentationItem: DocumentationItem;

    @Prop({ type: Date, required: true })
    expiresAt: Date;
}

export const DocumentationSearchCacheSchema = SchemaFactory.createForClass(
    DocumentationSearchCacheModel,
);

DocumentationSearchCacheSchema.index(
    {
        provider: 1,
        packageNameNormalized: 1,
        queryNormalized: 1,
    },
    {
        unique: true,
        name: 'idx_doc_search_cache_key',
        background: true,
    },
);

// TTL index: MongoDB deletes docs automatically once expiresAt is reached.
DocumentationSearchCacheSchema.index(
    { expiresAt: 1 },
    {
        expireAfterSeconds: 0,
        name: 'idx_doc_search_cache_ttl',
        background: true,
    },
);

export const DocumentationSearchCacheModelInstance = {
    name: DocumentationSearchCacheModel.name,
    schema: DocumentationSearchCacheSchema,
};
