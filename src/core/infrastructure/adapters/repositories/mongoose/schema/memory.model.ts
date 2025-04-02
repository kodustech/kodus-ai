import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'memory',
    timestamps: true,
    autoIndex: true,
})
export class MemoryModel extends CoreDocument {
    @Prop({ type: String })
    public message: string;
}

const MemorySchema = SchemaFactory.createForClass(MemoryModel);

export { MemorySchema };
