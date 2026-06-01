import { IKodyRule } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'kodyRules',
    timestamps: true,
    autoIndex: true,
})
export class KodyRulesModel {
    // findOne({ organizationId }) is the hottest query on this
    // collection and also runs as a prefix for every aggregation
    // (rule lookups, limit counts, sync filters). Without an index
    // it degenerates into a collection scan once the org count grows.
    @Prop({ type: String, required: true, index: true })
    public organizationId: string;

    @Prop({ type: Array, required: true })
    public rules: IKodyRule[];
}

export const KodyRulesSchema = SchemaFactory.createForClass(KodyRulesModel);
