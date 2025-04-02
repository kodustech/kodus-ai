import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import { SprintEntity } from '../entities/sprint.entity';
import { ISprint } from '../interface/sprint.interface';
import { FindManyOptions, FindOptions } from 'typeorm';

export const SPRINT_REPOSITORY_TOKEN = Symbol('SprintRepository');

export interface ISprintRepository {
    find(
        filter?: Partial<ISprint>,
        options?: FindManyOptions,
    ): Promise<SprintEntity[]>;
    findOne(filter?: Partial<ISprint>): Promise<SprintEntity>;
    findById(uuid: string): Promise<SprintEntity | undefined>;
    create(sprint: ISprint): Promise<SprintEntity | undefined>;
    update(
        filter: Partial<ISprint>,
        data: Partial<ISprint>,
    ): Promise<SprintEntity | undefined>;
    delete(uuid: string): Promise<void>;
    createOrUpdateSprintValue(
        organizationAndTeamData: OrganizationAndTeamData,
        sprint: ISprint,
    );
}
