import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';

export class PullRequestClosedEvent {
    constructor(
        public readonly organizationAndTeamData: OrganizationAndTeamData,
        public readonly repository: {
            id: string;
            name: string;
            fullName?: string;
        },
        public readonly pullRequestNumber: number,
        public readonly files?: Array<{
            filename: string;
            previous_filename?: string;
            status: string;
        }>,
        public readonly merged: boolean = true,
    ) {}
}
