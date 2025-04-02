import { Inject, Injectable } from '@nestjs/common';
import { ISnoozedItemsService } from '@/core/domain/snoozedItems/contracts/snoozedItems.service.contracts';
import { SnoozedItemsEntity } from '@/core/domain/snoozedItems/entities/snoozedItems.entity';
import {
    ISnoozedItemsRepository,
    SNOOZED_ITEMS_REPOSITORY_TOKEN,
} from '@/core/domain/snoozedItems/contracts/snoozedItems.repository';
import { ISnoozedItem } from '@/core/domain/snoozedItems/interfaces/snoozedItems.interface';
import { ModuleCategory } from '@/core/domain/snoozedItems/enums/module-category.enum';
import { SectionType } from '@/core/domain/snoozedItems/enums/section-type.enum';
import { CHECKIN_HISTORY_SERVICE_TOKEN } from '@/core/domain/checkinHistory/contracts/checkinHistory.service.contracts';
import { CheckinHistoryService } from '../checkinHistory.service';
import { OrganizationAndTeamDataDto } from '@/core/infrastructure/http/dtos/organizationAndTeamData.dto';
import { CHECKIN_TYPE } from '@/core/domain/checkinHistory/enums/checkin-type.enum';
import { SnoozeTime } from '@/core/domain/snoozedItems/enums/snooze-time.enum';
import { NotificationLevel } from '@/core/domain/snoozedItems/enums/notification-level.enum';

@Injectable()
export class SnoozedItemsService implements ISnoozedItemsService {
    constructor(
        @Inject(SNOOZED_ITEMS_REPOSITORY_TOKEN)
        private readonly snoozedItemsRepository: ISnoozedItemsRepository,

        @Inject(CHECKIN_HISTORY_SERVICE_TOKEN)
        private readonly checkinHistoryService: CheckinHistoryService,
    ) {}

    create(
        snoozedItem: Omit<ISnoozedItem, 'uuid'>,
    ): Promise<SnoozedItemsEntity> {
        return this.snoozedItemsRepository.create(snoozedItem);
    }

    prepareDataToSave(
        params: any,
        organizationId: string,
    ): Promise<SnoozedItemsEntity> {
        const snoozeTimeValue =
            params.snoozeTime.toLowerCase() === SnoozeTime.FOREVER
                ? 365
                : parseInt(SnoozeTime[params.snoozeTime]);

        params.snoozeObject = this.generateSnoozeObject(
            params.snoozeItemKey,
            params.snoozedBy,
            params.sectionType,
            params.snoozeObject,
            snoozeTimeValue,
        );

        const snoozedItem = new SnoozedItemsEntity({
            snoozeUntil: new Date(
                Date.now() + snoozeTimeValue * 24 * 60 * 60 * 1000,
            ),
            snoozeStart: new Date(),
            category: params.category,
            sectionType: params.sectionType,
            notificationLevel: params?.notificationLevel,
            snoozeObject: params.snoozeObject,
            teamId: params?.teamId,
            organizationId: organizationId,
            snoozedBy: params.snoozedBy,
        });

        return this.snoozedItemsRepository.create(snoozedItem);
    }

    findById(uuid: string): Promise<SnoozedItemsEntity | null> {
        throw new Error('Method not implemented.');
    }

    findOne(
        filter?: Partial<ISnoozedItem>,
    ): Promise<SnoozedItemsEntity | null> {
        throw new Error('Method not implemented.');
    }

    find(filter?: Partial<ISnoozedItem>): Promise<SnoozedItemsEntity[]> {
        return this.snoozedItemsRepository.find(filter);
    }

    async getByCategory(params: {
        teamId?: string;
        organizationId: string;
        category: ModuleCategory;
        snoozedDate?: Date;
    }): Promise<SnoozedItemsEntity[]> {
        const snoozedDate: Date = params.snoozedDate || new Date();

        const filter: Partial<ISnoozedItem> = {
            teamId: params.teamId,
            organizationId: params.organizationId,
            snoozeUntil: { $gte: snoozedDate } as any,
        };
        return this.snoozedItemsRepository.find(filter);
    }

    async getBySectionType(params: {
        teamId?: string;
        organizationId: string;
        sectionType: SectionType;
        snoozedDate?: Date;
    }): Promise<SnoozedItemsEntity[]> {
        const snoozedDate: Date = params.snoozedDate || new Date();

        const filter: Partial<ISnoozedItem> = {
            teamId: params.teamId,
            organizationId: params.organizationId,
            snoozeUntil: { $gte: snoozedDate } as any,
            sectionType: params.sectionType,
        };
        return this.snoozedItemsRepository.find(filter);
    }

    async getByTeamId(teamId: string): Promise<SnoozedItemsEntity[]> {
        return this.snoozedItemsRepository.find({ teamId });
    }

    async getByOrganizationId(
        organizationId: string,
    ): Promise<SnoozedItemsEntity[]> {
        return this.snoozedItemsRepository.find({ organizationId });
    }

    public async removeFromNotification(
        sectionItems: any[],
        sectionId: string,
        snoozedItems: any[],
        keyProperty: string,
        checkinType: CHECKIN_TYPE,
        organizationAndTeamData: OrganizationAndTeamDataDto,
    ) {
        let removeSnoozedItemsManually;

        if (!snoozedItems?.length) {
            removeSnoozedItemsManually = sectionItems;
        } else {
            removeSnoozedItemsManually =
                await this.filterSectionsBySnoozedItems(
                    sectionItems,
                    snoozedItems,
                    keyProperty,
                );
        }

        const filteredSectionDataItemns =
            await this.automaticallyRemoveFromNotification(
                removeSnoozedItemsManually,
                sectionId,
                keyProperty,
                checkinType,
                organizationAndTeamData,
            );

        return filteredSectionDataItemns;
    }

    private async filterSectionsBySnoozedItems(
        sectionItems,
        snoozedItems,
        keyProperty,
    ) {
        const snoozedIdentifications = snoozedItems
            .map((item) =>
                item._snoozeObject?.sectionItemIdentification?.toLowerCase(),
            )
            .filter(Boolean);

        return sectionItems.filter((section) => {
            const sectionKey = section[keyProperty].toString()?.toLowerCase();
            return !sectionKey || !snoozedIdentifications.includes(sectionKey);
        });
    }

    private async automaticallyRemoveFromNotification(
        sectionItems: any[],
        sectionId: string,
        keyProperty: string,
        checkinType: CHECKIN_TYPE,
        organizationAndTeamData: OrganizationAndTeamDataDto,
    ) {
        const checkinHistory =
            await this.checkinHistoryService.getCheckinHistoryByDays(
                {
                    teamId: organizationAndTeamData.teamId,
                    organizationId: organizationAndTeamData.organizationId,
                    type: checkinType,
                },
                2,
            );

        if (!checkinHistory?.length || !sectionItems?.length) {
            return sectionItems;
        }
        const sectionDataItems = checkinHistory
            .map((x) => x?.sectionDataItems)
            .flat()
            .filter((item) => item !== undefined);

        if (!sectionDataItems?.length) {
            return sectionItems;
        }

        const combinedItemsSent = sectionDataItems?.reduce((acc, item) => {
            if (item[sectionId] && item[sectionId]?.itemsSent) {
                acc.push(...item[sectionId]?.itemsSent);
            }
            return acc;
        }, []);

        if (!combinedItemsSent.length) {
            return sectionItems;
        }

        const sentItemKeys = new Set(
            combinedItemsSent.map((item) => String(item[Object.keys(item)[0]])),
        );

        const filteredItems = sectionItems.filter(
            (item) => !sentItemKeys.has(String(item[keyProperty])),
        );

        await this.saveAutomaticallySnooze(
            sectionItems.filter((item) =>
                sentItemKeys.has(String(item[keyProperty])),
            ),
            sectionId,
            keyProperty,
            organizationAndTeamData,
        );

        return filteredItems;
    }

    private async saveAutomaticallySnooze(
        snoozedItems: any[],
        sectionId: string,
        keyProperty: string,
        organizationAndTeamData: OrganizationAndTeamDataDto,
    ) {
        for (const item of snoozedItems) {
            const snoozeTimeKey = Object.keys(SnoozeTime).find(
                (key) => SnoozeTime[key] === SnoozeTime.TWO_DAYS,
            );

            await this.prepareDataToSave(
                {
                    category: ModuleCategory.CHECKIN,
                    sectionType: sectionId as SectionType,
                    notificationLevel: NotificationLevel.TEAM,
                    snoozeTime: snoozeTimeKey as SnoozeTime,
                    snoozeItemKey: String(item[keyProperty]),
                    teamId: organizationAndTeamData.teamId,
                    snoozedBy: {
                        userName: 'Kody',
                        userId: '001',
                    },
                },
                organizationAndTeamData.organizationId,
            );
        }
    }

    private generateSnoozeObject(
        snoozeItemKey: string,
        snoozedBy,
        sectionType,
        snoozeObject,
        snoozeTimeValue,
    ): Object {
        if (!snoozeItemKey) snoozeItemKey = snoozeObject?.name;

        snoozeObject = {
            sectionId: sectionType,
            sectionItemIdentification: snoozeItemKey,
            description: this.generateDescription(
                snoozedBy,
                snoozeTimeValue,
                sectionType,
                snoozeItemKey,
            ),
        };

        return snoozeObject;
    }

    private generateDescription(
        snoozedBy: any,
        snoozeTimeValue: number,
        sectionType: SectionType,
        snoozeItemKey?: string,
    ): string {
        if (!snoozeItemKey) return 'Unable to identify the snoozed item';

        switch (sectionType) {
            case SectionType.LATE_WORK_ITEMS:
                return `The alert about the WorkItem ${snoozeItemKey.toUpperCase()} which is late, and belongs to the section ${sectionType}, was snoozed for ${snoozeTimeValue} ${snoozeTimeValue === 1 ? 'day' : 'days'} by the user ${snoozedBy.userName}.`;
            case SectionType.PULL_REQUESTS_OPENED:
                return `The alert about the pull request ${snoozeItemKey} in the section ${sectionType}, was snoozed for ${snoozeTimeValue} ${snoozeTimeValue === 1 ? 'day' : 'days'} by the user ${snoozedBy.userName}.`;
            case SectionType.TEAM_ARTIFACTS:
                return `The alert about the artifact ${snoozeItemKey} in the section ${sectionType}, was snoozed for ${snoozeTimeValue} ${snoozeTimeValue === 1 ? 'day' : 'days'} by the user ${snoozedBy.userName}.`;
            default:
                return `Unable to identify the snoozed item.`;
        }
    }
}
