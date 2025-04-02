import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { ISnoozedItemsRepository } from '@/core/domain/snoozedItems/contracts/snoozedItems.repository';

import { SnoozedItemModel } from './schema/snoozedItem.model';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { SnoozedItemsEntity } from '@/core/domain/snoozedItems/entities/snoozedItems.entity';
import { ISnoozedItem } from '@/core/domain/snoozedItems/interfaces/snoozedItems.interface';

@Injectable()
export class SnoozedItemsDatabaseRepository implements ISnoozedItemsRepository {
    constructor(
        @InjectModel(SnoozedItemModel.name)
        private readonly snoozedItemModel: Model<SnoozedItemModel>,
    ) {}

    async create(
        snoozedItem: Omit<ISnoozedItem, 'uuid'>,
    ): Promise<SnoozedItemsEntity> {
        try {
            const snoozedItemObject = new SnoozedItemsEntity(
                snoozedItem,
            ).toObject();

            const snoozedItemSaved =
                await this.snoozedItemModel.create(snoozedItemObject);

            return snoozedItemSaved
                ? mapSimpleModelToEntity(snoozedItemSaved, SnoozedItemsEntity)
                : null;
        } catch (error) {
            console.log(error);
        }
    }

    async find(filter?: Partial<ISnoozedItem>): Promise<SnoozedItemsEntity[]> {
        try {
            const snoozedItems = await this.snoozedItemModel
                .find({
                    ...filter,
                })
                .exec();

            return snoozedItems
                ? mapSimpleModelsToEntities(snoozedItems, SnoozedItemsEntity)
                : null;
        } catch (error) {
            console.log('Error while fetching snoozed items:', error);
        }
    }

    async findById(uuid: string): Promise<SnoozedItemsEntity | null> {
        try {
            const snoozedItem = await this.snoozedItemModel
                .findById(uuid)
                .exec();
            return snoozedItem
                ? mapSimpleModelToEntity(snoozedItem, SnoozedItemsEntity)
                : null;
        } catch (error) {
            console.error('Error while fetching snoozed item by ID:', error);
            throw error;
        }
    }

    async findOne(
        filter?: Partial<ISnoozedItem>,
    ): Promise<SnoozedItemsEntity | null> {
        try {
            const snoozedItem = await this.snoozedItemModel
                .findOne(filter || {})
                .exec();
            return snoozedItem
                ? mapSimpleModelToEntity(snoozedItem, SnoozedItemsEntity)
                : null;
        } catch (error) {
            console.error('Error while fetching a snoozed item:', error);
            throw error;
        }
    }
}
