import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'checkinHistory',
    timestamps: true,
    autoIndex: true,
})
export class CheckinHistoryModel extends CoreDocument {
    @Prop({ type: Date })
    public date: Date;

    @Prop({ type: String })
    public teamId: string;

    @Prop({ type: String })
    public type: string;

    @Prop({ type: String })
    public organizationId: string;

    @Prop({ type: String })
    public content: string;

    @Prop({ type: Object })
    public sectionDataItems: any;

    @Prop({ type: Array})
    public overdueWorkItemsList: Array<string>;
}

const CheckinHistorySchema = SchemaFactory.createForClass(CheckinHistoryModel);

export { CheckinHistorySchema };
