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

// findById() looks a rule up by its embedded `rules.uuid` with no
// organizationId prefix (the rule uuid is a globally-unique v4, and the
// review pipeline resolves rules by id alone). Without a multikey index
// on the embedded array that query is a full collection scan across every
// org's document. This index turns it into a sub-ms lookup.
KodyRulesSchema.index({ 'rules.uuid': 1 });
