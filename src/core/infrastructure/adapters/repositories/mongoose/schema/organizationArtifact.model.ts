import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';
import mongoose, { Document, Mixed, Types } from 'mongoose';

@Schema({ timestamps: true })
export class Dismiss extends Document {
    @Prop({ required: true })
    dismiss: boolean;

    @Prop({ required: true })
    userId: string;
}

const DismissSchema = SchemaFactory.createForClass(Dismiss);

export class OrganizationTeamArtifactModel extends Document {
    @Prop({ required: true })
    teamId: string;

    @Prop({ required: true })
    teamName: string;

    @Prop({ required: true })
    title: string;

    @Prop({ required: true })
    criticality: string;

    @Prop({ required: true })
    resultType: string;

    @Prop({ required: true })
    description: string;

    @Prop({ required: true })
    howIsIdentified: string;

    @Prop({ type: mongoose.Schema.Types.Mixed })
    public additionalData: Mixed;

    @Prop({ type: [DismissSchema], default: [] })
    public dismiss: Types.Array<Dismiss>;
}

@Schema({
    collection: 'organizationArtifacts',
    timestamps: true,
    autoIndex: true,
})
export class OrganizationArtifactsModel extends CoreDocument {
    @Prop({ type: String })
    public name: string;

    @Prop({ type: Date })
    public analysisInitialDate: Date;

    @Prop({ type: Date })
    public analysisFinalDate: Date;

    @Prop({ type: String })
    public organizationId: string;

    @Prop({ type: String })
    public category: string;

    @Prop({ type: String })
    public description: string;

    @Prop({ type: String })
    public relatedItems: string;

    @Prop({ type: String })
    public resultType: string;

    @Prop({ type: String })
    public impactArea: string;

    @Prop({ type: String })
    public howIsIdentified: string;

    @Prop({ type: String })
    public whyIsImportant: string;

    @Prop({ type: String })
    public frequenceType: string;

    @Prop({ type: String })
    public additionalInfoFormated: string;

    @Prop({ type: [{ type: Types.ObjectId, ref: 'OrganizationTeamArtifact' }] })
    public teamsArtifact: OrganizationTeamArtifactModel[];
}

const OrganizationArtifactsSchema = SchemaFactory.createForClass(
    OrganizationArtifactsModel,
);

export { OrganizationArtifactsSchema };
