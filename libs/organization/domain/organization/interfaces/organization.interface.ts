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
    users?: Partial<TUser>[] | null;
    teams?: Partial<TTeam>[] | null;
}

/**
 * What creating an organization takes. The first touch is written then and
 * never read back (the column is not selected), so IOrganization, which is
 * what a read returns, does not have it.
 */
export type CreateOrganization = IOrganization & {
    firstTouch?: FirstTouch | null;
};
