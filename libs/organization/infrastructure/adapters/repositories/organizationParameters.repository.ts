import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { v4 as uuidv4 } from 'uuid';
import {
    EntityManager,
    FindManyOptions,
    FindOneOptions,
    Repository,
    UpdateQueryBuilder,
} from 'typeorm';

import { OrganizationParametersModel } from './schemas/organizationParameters.model';

import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import {
    ConfigValueMerge,
    IOrganizationParametersRepository,
} from '@libs/organization/domain/organizationParameters/contracts/organizationParameters.repository.contract';
import { OrganizationParametersEntity } from '@libs/organization/domain/organizationParameters/entities/organizationParameters.entity';
import { IOrganizationParameters } from '@libs/organization/domain/organizationParameters/interfaces/organizationParameters.interface';
import { OrganizationParametersKey } from '@libs/core/domain/enums/organization-parameters-key.enum';
import { createNestedConditions } from '@libs/core/infrastructure/repositories/model/filters';
import {
    mapSimpleModelToEntity,
    mapSimpleModelsToEntities,
} from '@libs/core/infrastructure/repositories/mappers';

@Injectable()
export class OrganizationParametersRepository implements IOrganizationParametersRepository {
    constructor(
        @InjectRepository(OrganizationParametersModel)
        private readonly organizationParametersRepository: Repository<OrganizationParametersModel>,
    ) {}

    async find(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity[]> {
        try {
            const { organization, ...otherFilterAttributes } = filter || {};

            const teamCondition = createNestedConditions(
                'organization',
                organization,
            );

            const findOptions: FindManyOptions<OrganizationParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...teamCondition,
                },
                relations: ['organization'],
            };

            const organizationParametersModel =
                await this.organizationParametersRepository.find(findOptions);

            return mapSimpleModelsToEntities(
                organizationParametersModel,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findOne(
        filter?: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity> {
        try {
            const { organization, ...otherFilterAttributes } = filter || {};

            const organizationCondition = createNestedConditions(
                'organization',
                organization,
            );

            const findOptions: FindManyOptions<OrganizationParametersModel> = {
                where: {
                    ...otherFilterAttributes,
                    ...organizationCondition,
                },
                relations: ['organization'],
            };

            const organizationParametersModel =
                await this.organizationParametersRepository.findOne(
                    findOptions,
                );

            return mapSimpleModelToEntity(
                organizationParametersModel,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async findByOrganizationName(
        organizationName: string,
    ): Promise<OrganizationParametersEntity | undefined> {
        try {
            const response = await this.organizationParametersRepository
                .createQueryBuilder('organizationParameters')
                .leftJoinAndSelect(
                    'organizationParameters.integration',
                    'integration',
                )
                .where('organizationParameters.configValue @> :item::jsonb', {
                    item: JSON.stringify({
                        organizationName: organizationName,
                    }),
                })
                .getOne();

            if (!response) {
                return null;
            }

            return mapSimpleModelToEntity(
                response,
                OrganizationParametersEntity,
            );
        } catch (err) {
            console.log(err);
        }
    }

    async findById(uuid: string): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder =
                this.organizationParametersRepository.createQueryBuilder(
                    'organizationParameters',
                );

            const organizationParametersSelected = await queryBuilder
                .where('organizationParameters.uuid = :uuid', { uuid })
                .getOne();

            return mapSimpleModelToEntity(
                organizationParametersSelected,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }

    async create(
        integrationConfig: IOrganizationParameters,
    ): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder =
                this.organizationParametersRepository.createQueryBuilder(
                    'organizationParameters',
                );

            const integrationConfigModel =
                this.organizationParametersRepository.create(integrationConfig);

            const integrationConfigCreated = await queryBuilder
                .insert()
                .values(integrationConfigModel)
                .execute();

            if (integrationConfigCreated?.identifiers[0]?.uuid) {
                const findOneOptions: FindOneOptions<OrganizationParametersModel> =
                    {
                        where: {
                            uuid: integrationConfigCreated.identifiers[0].uuid,
                        },
                    };

                const integrationConfig =
                    await this.organizationParametersRepository.findOne(
                        findOneOptions,
                    );

                if (!integrationConfig) return undefined;

                return mapSimpleModelToEntity(
                    integrationConfig,
                    OrganizationParametersEntity,
                );
            }
        } catch (error) {
            console.log(error);
        }
    }

    async update(
        filter: Partial<IOrganizationParameters>,
        data: Partial<IOrganizationParameters>,
    ): Promise<OrganizationParametersEntity> {
        try {
            const queryBuilder: UpdateQueryBuilder<OrganizationParametersModel> =
                this.organizationParametersRepository
                    .createQueryBuilder('organizationParameters')
                    .update(OrganizationParametersModel)
                    .where(filter)
                    .set(data);

            const result = await queryBuilder.execute();

            if (result.affected > 0) {
                const { organization, ...otherFilterAttributes } = filter || {};

                const organizationCondition = createNestedConditions(
                    'organization',
                    organization,
                );

                const findOptions: FindManyOptions<OrganizationParametersModel> =
                    {
                        where: {
                            ...otherFilterAttributes,
                            ...organizationCondition,
                        },
                        relations: ['organization'],
                    };

                const integrationConfig =
                    await this.organizationParametersRepository.findOne(
                        findOptions,
                    );

                if (integrationConfig) {
                    return mapSimpleModelToEntity(
                        integrationConfig,
                        OrganizationParametersEntity,
                    );
                }
            }

            return undefined;
        } catch (error) {
            console.log(error);
        }
    }
    async delete(uuid: string): Promise<void> {
        try {
            await this.organizationParametersRepository.delete(uuid);
        } catch (error) {
            console.log(error);
        }
    }

    async mergeConfigValue(
        configKey: OrganizationParametersKey,
        organizationId: string,
        patch: Record<string, unknown>,
        options: ConfigValueMerge = {},
    ): Promise<void> {
        const { connectionId, onlyIfAbsent } = options;
        const manager = this.organizationParametersRepository.manager;
        const value = JSON.stringify(patch);

        const merge = async (runner: Pick<EntityManager, 'query'>) => {
            const [, affected] = (
                connectionId
                    ? await runner.query(
                          `UPDATE "organization_parameters" op
                              SET "configValue" = jsonb_set(
                                      COALESCE(op."configValue", '{}'::jsonb)
                                          || jsonb_build_object('connections', COALESCE(op."configValue"->'connections', '{}'::jsonb)),
                                      ARRAY['connections', $3::text],
                                      COALESCE(op."configValue"->'connections'->$3::text, '{}'::jsonb) || $4::jsonb
                                  ),
                                  "updatedAt" = now()
                            WHERE op."organization_id" = $1
                              AND op."configKey" = $2
                              ${onlyIfAbsent ? `AND NOT (COALESCE(op."configValue"->'connections', '{}'::jsonb) ? $3::text)` : ''}`,
                          [organizationId, configKey, connectionId, value],
                      )
                    : await runner.query(
                          `UPDATE "organization_parameters" op
                              SET "configValue" = COALESCE(op."configValue", '{}'::jsonb) || $3::jsonb,
                                  "updatedAt" = now()
                            WHERE op."organization_id" = $1
                              AND op."configKey" = $2`,
                          [organizationId, configKey, value],
                      )
            ) as [unknown, number];
            return affected > 0;
        };
        if (await merge(manager)) return;

        await this.createUnlessPresent(
            organizationId,
            configKey,
            merge,
            connectionId ? { connections: { [connectionId]: patch } } : patch,
        );
    }

    async seedBotIds(
        organizationId: string,
        botIds: string[],
        options: { connectionId?: string } = {},
    ): Promise<void> {
        const configKey = OrganizationParametersKey.AUTO_LICENSE_ASSIGNMENT;
        const bots = [...new Set(botIds.map(String))];
        if (!bots.length) return;
        const { connectionId } = options;
        const lists = connectionId
            ? `op."configValue"->'connections'->$4::text`
            : `op."configValue"`;
        // Existing entries stay as stored; ids are compared as text.
        const appended = (array: string, added: string) => `(
            SELECT COALESCE(jsonb_agg(s.e ORDER BY s.o), '[]'::jsonb) FROM (
                SELECT t.e, t.o
                  FROM jsonb_array_elements(COALESCE(${array}, '[]'::jsonb)) WITH ORDINALITY AS t(e, o)
                UNION ALL
                SELECT to_jsonb(n.v), 1000000000 + n.o
                  FROM unnest(${added}) WITH ORDINALITY AS n(v, o)
                 WHERE NOT EXISTS (
                     SELECT 1 FROM jsonb_array_elements_text(COALESCE(${array}, '[]'::jsonb)) x
                      WHERE x = n.v)
            ) s)`;
        // Only bots never seeded before are ignored: one an admin chose to
        // review stays reviewed. The allow list is never written.
        const neverSeeded = `ARRAY(
            SELECT b FROM unnest($3::text[]) b
             WHERE NOT EXISTS (
                 SELECT 1 FROM jsonb_array_elements_text(COALESCE(${lists}->'seededBotIds', '[]'::jsonb)) x
                  WHERE x = b))`;
        const seeded = `jsonb_build_object(
            'ignoredUsers', ${appended(`${lists}->'ignoredUsers'`, neverSeeded)},
            'seededBotIds', ${appended(`${lists}->'seededBotIds'`, '$3::text[]')})`;

        const seed = async (runner: Pick<EntityManager, 'query'>) => {
            const [, affected] = (
                connectionId
                    ? await runner.query(
                          `UPDATE "organization_parameters" op
                              SET "configValue" = jsonb_set(
                                      COALESCE(op."configValue", '{}'::jsonb)
                                          || jsonb_build_object('connections', COALESCE(op."configValue"->'connections', '{}'::jsonb)),
                                      ARRAY['connections', $4::text],
                                      COALESCE(${lists}, '{"allowedUsers": []}'::jsonb) || ${seeded}
                                  ),
                                  "updatedAt" = now()
                            WHERE op."organization_id" = $1
                              AND op."configKey" = $2`,
                          [organizationId, configKey, bots, connectionId],
                      )
                    : await runner.query(
                          `UPDATE "organization_parameters" op
                              SET "configValue" = COALESCE(op."configValue", '{}'::jsonb) || ${seeded},
                                  "updatedAt" = now()
                            WHERE op."organization_id" = $1
                              AND op."configKey" = $2`,
                          [organizationId, configKey, bots],
                      )
            ) as [unknown, number];
            return affected > 0;
        };
        if (await seed(this.organizationParametersRepository.manager)) return;

        const initial = { ignoredUsers: bots, seededBotIds: bots };
        await this.createUnlessPresent(
            organizationId,
            configKey,
            seed,
            connectionId
                ? {
                      connections: {
                          [connectionId]: { allowedUsers: [], ...initial },
                      },
                  }
                : initial,
        );
    }

    /**
     * No row yet: writers that find none take turns, so the first one
     * creates it and every later one applies its change to it.
     */
    private async createUnlessPresent(
        organizationId: string,
        configKey: OrganizationParametersKey,
        apply: (runner: Pick<EntityManager, 'query'>) => Promise<boolean>,
        initialValue: Record<string, unknown>,
    ): Promise<void> {
        await this.organizationParametersRepository.manager.transaction(
            async (transaction) => {
                await transaction.query(
                    `SELECT pg_advisory_xact_lock(hashtext($1))`,
                    [`organization_parameters:${organizationId}:${configKey}`],
                );
                if (await apply(transaction)) return;

                const existing = (await transaction.query(
                    `SELECT 1 FROM "organization_parameters"
                      WHERE "organization_id" = $1 AND "configKey" = $2
                      LIMIT 1`,
                    [organizationId, configKey],
                )) as unknown[];
                if (existing.length) return;

                await transaction.query(
                    `INSERT INTO "organization_parameters" ("uuid", "configKey", "configValue", "organization_id")
                     VALUES ($1, $2, $3::jsonb, $4)`,
                    [
                        uuidv4(),
                        configKey,
                        JSON.stringify(initialValue),
                        organizationId,
                    ],
                );
            },
        );
    }

    async findByKey(
        configKey: OrganizationParametersKey,
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<OrganizationParametersEntity> {
        const queryBuilder =
            this.organizationParametersRepository.createQueryBuilder(
                'organizationParameters',
            );

        const integrationConfigSelected = await queryBuilder
            .where('organizationParameters.configKey = :configKey', {
                configKey,
            })
            .andWhere(
                'organizationParameters.organization_id = :organizationId',
                {
                    organizationId: organizationAndTeamData.organizationId,
                },
            )
            .getOne();

        return mapSimpleModelToEntity(
            integrationConfigSelected,
            OrganizationParametersEntity,
        );
    }

    async findByKeyAndValue(filter: {
        configKey: OrganizationParametersKey;
        configValue: any;
        organizationAndTeamData?: OrganizationAndTeamData;
        fuzzy?: boolean;
    }): Promise<OrganizationParametersEntity[]> {
        try {
            const { configKey, configValue, organizationAndTeamData, fuzzy } =
                filter;

            const queryBuilder =
                this.organizationParametersRepository.createQueryBuilder(
                    'organizationParameters',
                );

            queryBuilder.leftJoinAndSelect(
                'organizationParameters.organization',
                'organization',
            );

            queryBuilder.where(
                'organizationParameters.configKey = :configKey',
                {
                    configKey,
                },
            );

            if (organizationAndTeamData) {
                queryBuilder.andWhere(
                    'organizationParameters.organization_id = :organizationId',
                    {
                        organizationId: organizationAndTeamData.organizationId,
                    },
                );
            }

            if (fuzzy) {
                queryBuilder.andWhere(
                    'organizationParameters.configValue @> :configValue',
                    { configValue: JSON.stringify(configValue) },
                );
            } else {
                queryBuilder.andWhere(
                    'organizationParameters.configValue = :configValue::jsonb',
                    { configValue: JSON.stringify(configValue) },
                );
            }

            const retrievedParameters = await queryBuilder.getMany();

            if (!retrievedParameters || retrievedParameters.length === 0) {
                return [];
            }

            return mapSimpleModelsToEntities(
                retrievedParameters,
                OrganizationParametersEntity,
            );
        } catch (error) {
            console.log(error);
        }
    }
}
