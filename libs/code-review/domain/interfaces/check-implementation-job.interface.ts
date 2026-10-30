import { PlatformType } from '@libs/core/domain/enums';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export interface CheckImplementationJobPayload {
    organizationAndTeamData: OrganizationAndTeamData;
    repository: { id: string; name: string };
    pullRequestNumber: number;
    commitSha: string;
    trigger: 'synchronize' | 'synchronized' | 'closed' | 'review_completed';
    correlationId?: string;
    // Optional metadata
    payload?: any;
    event?: string;
    platformType?: PlatformType;
}
