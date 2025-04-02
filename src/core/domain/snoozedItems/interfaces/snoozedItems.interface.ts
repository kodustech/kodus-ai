import { ModuleCategory } from "../enums/module-category.enum";
import { NotificationLevel } from "../enums/notification-level.enum";
import { SectionType } from "../enums/section-type.enum";

export interface ISnoozedItem {
    uuid: string;
    snoozeUntil: Date;
    snoozeStart: Date;
    category: ModuleCategory;
    sectionType: SectionType;
    notificationLevel?: NotificationLevel;
    snoozeObject: any[];
    teamId?: string;
    organizationId: string;
    snoozedBy: {
        userId: string;
        userName: string;
    };
}
