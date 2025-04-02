import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';
import mongoose, { Mixed, Types } from 'mongoose';
import { Dismiss } from './organizationArtifact.model';

const DismissSchema = SchemaFactory.createForClass(Dismiss);

@Schema({
    collection: 'teamArtifacts',
    timestamps: true,
    autoIndex: true,
})
export class TeamArtifactsModel extends CoreDocument {
    @Prop({ type: String })
    public name: string;

    @Prop({ type: String })
    public title: string;

    @Prop({ type: Date })
    public analysisInitialDate: Date;

    @Prop({ type: Date })
    public analysisFinalDate: Date;

    @Prop({ type: String })
    public teamId: string;

    @Prop({ type: String })
    public organizationId: string;

    @Prop({ type: String })
    public category: string;

    @Prop({ type: String })
    public description: string;

    @Prop({ type: String })
    public relatedItems: string;

    @Prop({ type: String, required: false })
    public criticality: string;

    @Prop({ type: String })
    public resultType: string;

    @Prop({ type: String })
    public impactArea: string;

    @Prop({ type: Number })
    public impactLevel: string;

    @Prop({ type: String })
    public howIsIdentified: string;

    @Prop({ type: String })
    public whyIsImportant: string;

    @Prop({ type: String })
    public frequenceType: string;

    @Prop({ type: mongoose.Schema.Types.Mixed })
    public additionalData: Mixed;

    @Prop({ type: String, required: false })
    public additionalInfoFormated: string;

    @Prop({ type: mongoose.Schema.Types.Mixed, required: false })
    public relatedData: Mixed;

    @Prop({ type: mongoose.Schema.Types.Mixed, required: false })
    public impactDataRelationship: Mixed;

    @Prop({ type: String, required: false })
    public summaryOfRelatedItems: string;

    @Prop({ type: [DismissSchema], default: [] })
    public dismiss: Types.Array<Dismiss>;
}

const TeamArtifactsSchema = SchemaFactory.createForClass(TeamArtifactsModel);

export { TeamArtifactsSchema };
