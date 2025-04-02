import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';

@Schema({
    collection: 'checkinHistoryOrganization',
    timestamps: true,
    autoIndex: true,
})
export class CheckinHistoryOrganizationModel extends CoreDocument {
    @Prop({ type: Date })
    public date: Date;

    @Prop({ type: [String] })
    public teamsIds: string[];

    @Prop({ type: String })
    public type: string;

    @Prop({ type: String })
    public organizationId: string;

    @Prop({ type: String })
    public content: string;

    @Prop({ type: Array })
    public overdueWorkItemsList: Array<string>;
}

const CheckinHistoryOrganizationSchema = SchemaFactory.createForClass(CheckinHistoryOrganizationModel);

export { CheckinHistoryOrganizationSchema };
