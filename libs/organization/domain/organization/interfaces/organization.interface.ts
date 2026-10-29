import type { ReleaseTrack } from '@libs/feature-gate/domain/release-track';

import type { FirstTouch } from '../first-touch';

export interface IOrganization<TUser = any, TTeam = any> {
    uuid: string;
    name: string;
    tenantName: string;
    status: boolean;
    codeHostMemberCount?: number;
    codeHostMemberCountUpdatedAt?: Date;
    releaseTrack?: ReleaseTrack;
    firstTouch?: FirstTouch | null;
    users?: Partial<TUser>[] | null;
    teams?: Partial<TTeam>[] | null;
}
