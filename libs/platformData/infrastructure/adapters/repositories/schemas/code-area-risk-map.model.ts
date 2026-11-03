import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import type { CodeAreaRiskMap } from '@libs/platformData/domain/code-area-risk/build-area-risk-map';

@Schema({ collection: 'codeAreaRiskMaps', timestamps: true })
export class CodeAreaRiskMapModel {
    @Prop({ type: String, required: true })
    organizationId: string;

    @Prop({ type: String, required: true })
    repositoryId: string;

    @Prop({ type: Object, required: true })
    snapshot: CodeAreaRiskMap;
}

export const CodeAreaRiskMapSchema =
    SchemaFactory.createForClass(CodeAreaRiskMapModel);

CodeAreaRiskMapSchema.index(
    { organizationId: 1, repositoryId: 1 },
    { unique: true, name: 'organization_repository_area_map' },
);
