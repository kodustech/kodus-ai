import { STATUS } from '@libs/core/infrastructure/config/types/database/status.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

import { TeamMemberEntity } from '../entities/teamMember.entity';
import { IMembers, ITeamMember } from '../interfaces/teamMembers.interface';

export const TEAM_MEMBERS_REPOSITORY_TOKEN = Symbol.for(
    'TeamMembersRepository',
);

/** Runs SQL inside the transaction a member is inserted in. */
export type TeamMemberInsertRunner = {
    query(sql: string, parameters?: unknown[]): Promise<unknown>;
};

export interface ITeamMemberRepository {
    countByUser(userId: string, teamMemberStatus?: boolean): Promise<number>;
    countTeamMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<number>;
    /**
     * `alsoWithin` runs in the insert's transaction: when it fails, the
     * member is not created either.
     */
    create(
        teamMember: ITeamMember,
        options?: {
            alsoWithin?: (runner: TeamMemberInsertRunner) => Promise<void>;
        },
    ): Promise<any>;
    deleteMembers(members: TeamMemberEntity[]): Promise<void>;
    findManyByOrganizationId(
        organizationId: string,
        teamStatus: STATUS[],
    ): Promise<TeamMemberEntity[]>;
    findManyByRelations(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]>;
    findManyByUser(
        userId: string,
        teamMemberStatus: boolean,
    ): Promise<TeamMemberEntity[]>;
    findManyById(ids: string[]): Promise<TeamMemberEntity[]>;
    findMembersByCommunicationId(communicationId: string);
    findTeamMembersWithUser(
        organizationAndTeamData: OrganizationAndTeamData,
        teamMembersStatus?: boolean,
    ): Promise<TeamMemberEntity[]>;
    findOne(filter: Partial<ITeamMember>): Promise<TeamMemberEntity>;
    getLeaderMembers(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<TeamMemberEntity[]>;
    update(
        filter: Partial<ITeamMember>,
        teamMember: Partial<ITeamMember>,
    ): Promise<any>;
    updateMembers(
        members: IMembers[],
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<void>;
}
