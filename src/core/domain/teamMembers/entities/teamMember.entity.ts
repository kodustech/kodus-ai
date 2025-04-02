import { Entity } from '@/shared/domain/interfaces/entity';
import { IMembers, ITeamMember } from '../interfaces/team-members.interface';
import { IOrganization } from '../../organization/interfaces/organization.interface';
import { ITeam } from '../../team/interfaces/team.interface';
import { ICodeManagementMemberConfig } from '../interfaces/codeManagementMemberConfig.interface';
import { ICommuminicationMemberConfig } from '../interfaces/communicationMemberConfig.interface';
import { IProjectManagementMemberConfig } from '../interfaces/projectManagementMemberConfig';
import { IUser } from '../../user/interfaces/user.interface';
import { TeamMemberRole } from '../enums/teamMemberRole.enum';

export class TeamMemberEntity implements Entity<ITeamMember> {
    private _uuid: string;
    private _organization?: Partial<IOrganization>;
    private _team?: Partial<ITeam>;
    private _user?: Partial<IUser>;
    private _name: string;
    private _status: boolean;
    private _avatar?: string;
    private _teamRole: TeamMemberRole;
    private _communication?: ICommuminicationMemberConfig;
    private _codeManagement?: ICodeManagementMemberConfig;
    private _projectManagement?: IProjectManagementMemberConfig;
    private _communicationId: string;
    private _createdAt?: Date;

    private constructor(member: ITeamMember | Partial<ITeamMember>) {
        this._uuid = member.uuid;
        this._organization = member.organization;
        this._team = member.team;
        this._user = member.user;
        this._name = member.name;
        this._status = member.status;
        this._avatar = member.avatar;
        this._teamRole = member.teamRole;
        this._communication = member.communication;
        this._codeManagement = member.codeManagement;
        this._projectManagement = member.projectManagement;
        this._communicationId = member.communicationId;
        this._createdAt = member.createdAt;
    }

    public static create(
        member: ITeamMember | Partial<ITeamMember>,
    ): TeamMemberEntity {
        return new TeamMemberEntity(member);
    }

    public get uuid() {
        return this._uuid;
    }

    public get organization() {
        return this._organization;
    }

    public get team() {
        return this._team;
    }

    public get user() {
        return this._user;
    }

    public get name() {
        return this._name;
    }

    public get status() {
        return this._status;
    }

    public get avatar() {
        return this._avatar;
    }

    public get communication() {
        return this._communication;
    }

    public get teamRole() {
        return this._teamRole;
    }

    public get codeManagement() {
        return this._codeManagement;
    }

    public get projectManagement() {
        return this._projectManagement;
    }

    public get communicationId() {
        return this._communicationId;
    }

    public get createdAt() {
        return this._createdAt;
    }

    public toObject(): ITeamMember {
        return {
            uuid: this._uuid,
            organization: this._organization,
            team: this._team,
            user: this._user,
            name: this._name,
            status: this._status,
            avatar: this._avatar,
            communication: this._communication,
            codeManagement: this._codeManagement,
            projectManagement: this._projectManagement,
            communicationId: this._communicationId,
            teamRole: this._teamRole,
            createdAt: this._createdAt,
        };
    }

    public toJson(): Partial<ITeamMember> {
        return {
            uuid: this._uuid,
            organization: this._organization,
            team: this._team,
            name: this._name,
            status: this._status,
            avatar: this._avatar,
            communication: this._communication,
            codeManagement: this._codeManagement,
            projectManagement: this._projectManagement,
            communicationId: this._communicationId,
            teamRole: this._teamRole,
            createdAt: this._createdAt,
        };
    }
}
