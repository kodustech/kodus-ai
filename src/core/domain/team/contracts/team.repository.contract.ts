import { STATUS } from '@/config/types/database/status.type';
import { TeamEntity } from '../entities/team.entity';
import {
    ITeam,
    TeamsFilter,
    ITeamWithIntegrations,
} from '../interfaces/team.interface';
import { FindManyOptions } from 'typeorm';

export const TEAM_REPOSITORY_TOKEN = Symbol('TeamRepository');

export interface ITeamRepository {
    find(
        filter?: Omit<Partial<ITeam>, 'status'>,
        status?: STATUS[],
        options?: FindManyOptions,
    ): Promise<TeamEntity[]>;
    findOne(filter: Partial<ITeam>): Promise<TeamEntity | undefined>;
    findById(uuid: string): Promise<TeamEntity | undefined>;
    findManyByIds(teamIds: string[]): Promise<TeamEntity[]>;
    findTeamsWithIntegrations(
        params: TeamsFilter,
    ): Promise<ITeamWithIntegrations[]>;
    create(teamEntity: ITeam): Promise<TeamEntity | undefined>;
    update(
        filter: Partial<ITeam>,
        data: Partial<ITeam>,
    ): Promise<TeamEntity | undefined>;
    deleteOne(uuid: string): Promise<void>;
    findFirstCreatedTeam(
        organizationId: string,
    ): Promise<TeamEntity | undefined>;
    getTeamsByUserId(
        userId: string,
        organizationId: string,
        status?: STATUS[],
        options?: FindManyOptions<any>,
    ): Promise<TeamEntity[]>;
}
