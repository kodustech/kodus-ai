import { ModuleCategory } from '../enums/module-category.enum';
import { NotificationLevel } from '../enums/notification-level.enum';
import { SectionType } from '../enums/section-type.enum';
import { ISnoozedItem } from '../interfaces/snoozedItems.interface';

export class SnoozedItemsEntity implements ISnoozedItem {
    private _uuid: string;
    private _snoozeUntil: Date;
    private _snoozeStart: Date;
    private _category: ModuleCategory;
    private _sectionType: SectionType;
    private _notificationLevel?: NotificationLevel;
    private _snoozeObject: any;
    private _teamId?: string;
    private _organizationId: string;
    private _snoozedBy: {
        userId: string;
        userName: string;
    };

    constructor(snoozedItem: ISnoozedItem | Partial<ISnoozedItem>) {
        this._uuid = snoozedItem.uuid;
        this._snoozeUntil = snoozedItem.snoozeUntil;
        this._snoozeStart = snoozedItem.snoozeStart;
        this._category = snoozedItem.category;
        this._sectionType = snoozedItem.sectionType;
        this._notificationLevel = snoozedItem.notificationLevel;
        this._snoozeObject = snoozedItem.snoozeObject;
        this._teamId = snoozedItem.teamId;
        this._organizationId = snoozedItem.organizationId;
        this._snoozedBy = snoozedItem.snoozedBy;
    }

    toObject(): ISnoozedItem {
        return {
            uuid: this._uuid,
            snoozeUntil: this._snoozeUntil,
            snoozeStart: this._snoozeStart,
            category: this._category,
            sectionType: this._sectionType,
            notificationLevel: this._notificationLevel,
            snoozeObject: this._snoozeObject,
            teamId: this._teamId,
            organizationId: this._organizationId,
            snoozedBy: this._snoozedBy,
        };
    }

    toJson(): ISnoozedItem | Partial<ISnoozedItem> {
        return {
            uuid: this._uuid,
            snoozeUntil: this._snoozeUntil,
            snoozeStart: this._snoozeStart,
            category: this._category,
            sectionType: this._sectionType,
            notificationLevel: this._notificationLevel,
            snoozeObject: this._snoozeObject,
            teamId: this._teamId,
            organizationId: this._organizationId,
            snoozedBy: this._snoozedBy,
        };
    }

    public static create(
        snoozedItem: ISnoozedItem | Partial<ISnoozedItem>,
    ): SnoozedItemsEntity {
        return new SnoozedItemsEntity(snoozedItem);
    }

    get uuid(): string {
        return this._uuid;
    }

    get snoozeUntil(): Date {
        return this._snoozeUntil;
    }

    get snoozeStart(): Date {
        return this._snoozeStart;
    }

    get category(): ModuleCategory {
        return this._category;
    }

    get sectionType(): SectionType {
        return this._sectionType;
    }

    get notificationLevel(): NotificationLevel {
        return this._notificationLevel;
    }

    get snoozeObject(): any {
        return this._snoozeObject;
    }

    get teamId(): string | undefined {
        return this._teamId;
    }

    get organizationId(): string {
        return this._organizationId;
    }

    get snoozedBy(): {
        userId: string;
        userName: string;
    } {
        return this._snoozedBy;
    }
}
