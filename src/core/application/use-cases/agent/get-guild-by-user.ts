import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    AUTH_INTEGRATION_SERVICE_TOKEN,
    IAuthIntegrationService,
} from '@/core/domain/authIntegrations/contracts/auth-integration.service.contracts';
import {
    IProfileConfigService,
    PROFILE_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/profileConfigs/contracts/profileConfig.service.contract';
import { ProfileConfigKey } from '@/core/domain/profileConfigs/enum/profileConfigKey.enum';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class GetGuildByUserUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMemberService: ITeamMemberService,

        @Inject(AUTH_INTEGRATION_SERVICE_TOKEN)
        private readonly authIntegrationService: IAuthIntegrationService,

        @Inject(PROFILE_CONFIG_SERVICE_TOKEN)
        private readonly profileConfigService: IProfileConfigService,
    ) { }

    async execute(authDetailsParams: any) {
        let organizationId = '';
        let teamId = '';
        let communicationId =
            authDetailsParams?.userCommunicationData?.communicationId;

        if (communicationId) {
            const teamMembers =
                await this.teamMemberService.findMembersByCommunicationId(
                    communicationId,
                );

            const filteredMember = teamMembers?.filter(
                (teamMember) => teamMember.communicationId === communicationId,
            );

            organizationId =
                filteredMember && filteredMember?.length > 0
                    ? filteredMember[0].organization?.uuid
                    : undefined;

            teamId =
                filteredMember && filteredMember?.length > 0
                    ? filteredMember[0].team?.uuid
                    : undefined;
        }

        if (!organizationId) {
            const profileConfigService =
                await this.profileConfigService.findOne({
                    configKey: ProfileConfigKey.USER_NOTIFICATIONS,
                    configValue: {
                        communicationId:
                            authDetailsParams.userCommunicationData
                                .communicationId,
                    },
                });

            organizationId =
                profileConfigService?.profile?.user?.organization?.uuid;
            teamId = ''
        }

        if (organizationId) {
            const authDetailsResult =
                await this.authIntegrationService.getPlatformAuthDetails(
                    { organizationId, teamId },
                );

            organizationId = authDetailsResult?.organization?.uuid;
        }

        return {
            organizationId: organizationId,
            teamId: '',
        } as OrganizationAndTeamData;
    }
}
