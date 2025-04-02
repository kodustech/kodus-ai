
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@/shared/infrastructure/repositories/mappers';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, FindOneOptions, FindManyOptions } from 'typeorm';
import { ISuggestionEmbeddedRepository } from './domain/suggestionEmbedded/contracts/suggestionEmbedded.repository.contract';
import { SuggestionEmbeddedModel } from '@/core/infrastructure/adapters/repositories/typeorm/schema/suggestionEmbedded.model';
import { ISuggestionEmbedded } from './domain/suggestionEmbedded/interfaces/suggestionEmbedded.interface';
import { SuggestionEmbeddedEntity } from './domain/suggestionEmbedded/entities/suggestionEmbedded.entity';

@Injectable()
export class SuggestionEmbeddedDatabaseRepository
    implements ISuggestionEmbeddedRepository
{
    constructor(
        @InjectRepository(SuggestionEmbeddedModel)
        private readonly SuggestionEmbeddedRepository: Repository<SuggestionEmbeddedModel>,
    ) {}

    async create(
        entity: ISuggestionEmbedded,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        try {
            const queryBuilder =
                this.SuggestionEmbeddedRepository.createQueryBuilder(
                    'SuggestionEmbedded',
                );

            const SuggestionEmbeddedModel =
                this.SuggestionEmbeddedRepository.create(entity);
            const result = await queryBuilder
                .insert()
                .values(SuggestionEmbeddedModel)
                .execute();

            if (result && result.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<SuggestionEmbeddedModel> =
                    {
                        where: {
                            uuid: result.identifiers[0].uuid,
                        },
                    };

                const insertedEmbedding =
                    await this.SuggestionEmbeddedRepository.findOne(
                        findOneOptions,
                    );
                return insertedEmbedding
                    ? mapSimpleModelToEntity(
                          insertedEmbedding,
                          SuggestionEmbeddedEntity,
                      )
                    : undefined;
            }

            return undefined;
        } catch (error) {
            console.log(error);
            throw new Error('Error creating suggestion embedding');
        }
    }

    async find(
        filter?: Omit<Partial<ISuggestionEmbedded>, 'suggestionId'>,
        options?: FindManyOptions,
    ): Promise<SuggestionEmbeddedEntity[]> {
        try {
            const { organization, ...otherFilterAttributes }: any =
                filter || {};

            const findManyOptions: FindManyOptions<SuggestionEmbeddedModel> = {
                where: {
                    ...otherFilterAttributes,
                    organization: organization
                        ? { uuid: organization.uuid }
                        : undefined,
                },
                relations: ['organization'],
                ...options,
            } as FindManyOptions<SuggestionEmbeddedModel>;

            const embeddings =
                await this.SuggestionEmbeddedRepository.find(findManyOptions);

            return mapSimpleModelsToEntities(
                embeddings,
                SuggestionEmbeddedEntity,
            );
        } catch (error) {
            console.log(error);
            throw new Error('Error finding suggestion embeddings');
        }
    }

    async findOne(
        suggestionId: string,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        try {
            const findOneOptions: FindOneOptions<SuggestionEmbeddedModel> = {
                where: { suggestionId },
                relations: ['organization'],
            };

            const embedding =
                await this.SuggestionEmbeddedRepository.findOne(findOneOptions);
            return embedding
                ? mapSimpleModelToEntity(embedding, SuggestionEmbeddedEntity)
                : undefined;
        } catch (error) {
            console.log(error);
            throw new Error('Error finding suggestion embedding');
        }
    }

    async findById(
        uuid: string,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        try {
            const findOneOptions: FindOneOptions<SuggestionEmbeddedModel> = {
                where: { uuid },
            };

            const embedding =
                await this.SuggestionEmbeddedRepository.findOne(findOneOptions);
            return embedding
                ? mapSimpleModelToEntity(embedding, SuggestionEmbeddedEntity)
                : undefined;
        } catch (error) {
            console.log(error);
            throw new Error('Error finding suggestion embedding by ID');
        }
    }

    async update(
        filter: Partial<ISuggestionEmbedded>,
        data: Partial<ISuggestionEmbedded>,
    ): Promise<SuggestionEmbeddedEntity | undefined> {
        try {
            if (!filter.suggestionId) {
                throw new Error('SuggestionId is required for update');
            }

            const queryBuilder =
                this.SuggestionEmbeddedRepository.createQueryBuilder(
                    'SuggestionEmbedded',
                )
                    .update(SuggestionEmbeddedModel)
                    .where('suggestionId = :suggestionId', {
                        suggestionId: filter.suggestionId,
                    })
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const findOneOptions: FindOneOptions<SuggestionEmbeddedModel> =
                    {
                        where: { suggestionId: filter.suggestionId },
                        relations: ['organization'],
                    };

                const updatedEmbedding =
                    await this.SuggestionEmbeddedRepository.findOne(
                        findOneOptions,
                    );

                return updatedEmbedding
                    ? mapSimpleModelToEntity(
                          updatedEmbedding,
                          SuggestionEmbeddedEntity,
                      )
                    : undefined;
            }

            return undefined;
        } catch (error) {
            console.log(error);
            throw new Error('Error updating suggestion embedding');
        }
    }
}
