import { SnoozedItemsEntity } from '../entities/snoozedItems.entity';
import { ISnoozedItem } from '../interfaces/snoozedItems.interface';

export const SNOOZED_ITEMS_REPOSITORY_TOKEN = Symbol('SnoozedItemsRepository');

export interface ISnoozedItemsRepository {
    create(
        snoozedItem: Omit<ISnoozedItem, 'uuid'>,
    ): Promise<SnoozedItemsEntity>;
    findById(uuid: string): Promise<SnoozedItemsEntity | null>;
    findOne(filter?: Partial<ISnoozedItem>): Promise<SnoozedItemsEntity | null>;
    find(filter?: Partial<ISnoozedItem>): Promise<SnoozedItemsEntity[]>;
}
