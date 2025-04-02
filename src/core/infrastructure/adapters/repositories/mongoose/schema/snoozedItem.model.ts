import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { NotificationLevel } from '@/core/domain/snoozedItems/enums/notification-level.enum';
import { SectionType } from '@/core/domain/snoozedItems/enums/section-type.enum';
import { CoreDocument } from '@/shared/infrastructure/repositories/model/mongodb';
import { Prop, SchemaFactory, Schema } from '@nestjs/mongoose';
import mongoose, { Mixed, Types } from 'mongoose';

@Schema({
    collection: 'snoozedItems',
    timestamps: true,
    autoIndex: true,
})
export class SnoozedItemModel extends CoreDocument {
    @Prop({ type: Date, required: true })
    public snoozeUntil: Date;

    @Prop({ type: Date, required: true })
    public snoozeStart: Date;

    @Prop({ type: String, enum: Object.values(ModuleCategory), required: true })
    public category: ModuleCategory;

    @Prop({ type: String, enum: Object.values(SectionType), required: true })
    public sectionType: SectionType;

    @Prop({
        type: String,
        enum: Object.values(NotificationLevel),
        required: false,
    })
    public notificationLevel: NotificationLevel;

    @Prop({ type: mongoose.Schema.Types.Mixed, required: true })
    public snoozeObject: Mixed;

    @Prop({ type: String, required: false })
    public teamId?: string;

    @Prop({ type: String, required: true })
    public organizationId: string;

    @Prop({ type: mongoose.Schema.Types.Mixed, required: true })
    public snoozedBy: Mixed;
}

const SnoozedItemSchema = SchemaFactory.createForClass(SnoozedItemModel);

export { SnoozedItemSchema };
