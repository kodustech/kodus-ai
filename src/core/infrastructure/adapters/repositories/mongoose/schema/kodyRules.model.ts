import { IKodyRule } from '@/core/domain/kodyRules/interfaces/kodyRules.interface';
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';

@Schema({
    collection: 'kodyRules',
    timestamps: true,
    autoIndex: true,
})
export class KodyRulesModel {
    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: Array, required: true })
    public rules: IKodyRule[];
}

export const KodyRulesSchema = SchemaFactory.createForClass(KodyRulesModel);
