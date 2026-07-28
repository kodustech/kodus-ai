import type { ReleaseTrack } from '@libs/feature-gate/domain/release-track';

export interface IOrganization<TUser = any, TTeam = any> {
    uuid: string;
    name: string;
    tenantName: string;
    status: boolean;
    codeHostMemberCount?: number;
    codeHostMemberCountUpdatedAt?: Date;
    releaseTrack?: ReleaseTrack;
    users?: Partial<TUser>[] | null;
    teams?: Partial<TTeam>[] | null;
}
