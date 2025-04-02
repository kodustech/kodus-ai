import { STATUS } from '@/config/types/database/status.type';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ITeamMemberService,
    TEAM_MEMBERS_SERVICE_TOKEN,
} from '@/core/domain/teamMembers/contracts/teamMembers.service.contracts';
import { ITeamMember } from '@/core/domain/teamMembers/interfaces/team-members.interface';
import {
    IUsersService,
    USER_SERVICE_TOKEN,
} from '@/core/domain/user/contracts/user.service.contract';
import { IUser } from '@/core/domain/user/interfaces/user.interface';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { CommunicationService } from '@/core/infrastructure/adapters/services/platformIntegration/communication.service';
import { ProjectManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/projectManagement.service';
import { PromptService } from '@/core/infrastructure/adapters/services/prompt.service';
import { LLMModelProvider } from '@/shared/domain/enums/llm-model-provider.enum';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { getLLMModelProviderWithFallback } from '@/shared/utils/get-llm-model-provider.util';
import { getChatGPT, getOpenAI } from '@/shared/utils/langchainCommon/document';
import { safelyParseMessageContent } from '@/shared/utils/safelyParseMessageContent';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

export class PredictTeamCreationUseCase implements IUseCase {
    constructor(
        @Inject(TEAM_MEMBERS_SERVICE_TOKEN)
        private readonly teamMembersService: ITeamMemberService,

        @Inject(USER_SERVICE_TOKEN)
        private readonly userService: IUsersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },

        private logger: PinoLoggerService,
        private readonly communicationService: CommunicationService,
        private readonly projectManagementService: ProjectManagementService,
        private readonly codeManagementService: CodeManagementService,
        private readonly promptService: PromptService,
    ) {}
    public async execute(): Promise<any> {
        try {
            const organizationAndTeamData: OrganizationAndTeamData = {
                organizationId: this.request.user.organization.uuid,
            };

            const projectManagementToolMembers =
                await this.projectManagementService.getListMembers({
                    organizationAndTeamData,
                });

            const communicationToolMembers =
                await this.communicationService.getListMembers({
                    organizationAndTeamData,
                });

            const codeManagementMembers =
                await this.codeManagementService.getListMembers({
                    organizationAndTeamData,
                });

            const membersCorrelated = await this.correlateMembersWithLLM(
                organizationAndTeamData,
                {
                    communicationToolMembers,
                    projectManagementToolMembers,
                    codeManagementMembers,
                },
            );

            if (!membersCorrelated || membersCorrelated.lenght <= 0) {
                return [];
            }

            return await this.buildTeam(
                communicationToolMembers,
                projectManagementToolMembers,
                codeManagementMembers,
                membersCorrelated,
            );
        } catch (error) {
            this.logger.error({
                message: 'Error while trying to predict the team',
                context: PredictTeamCreationUseCase.name,
                serviceName: 'PredictTeamCreationUseCase',
                error: error,
                metadata: {
                    organizationId: this.request.user.organization.uuid,
                },
            });
        }
    }

    private async correlateMembersWithLLM(
        organizationAndTeamData: OrganizationAndTeamData,
        members,
    ) {
        let llm = getChatGPT({
            model: getLLMModelProviderWithFallback(
                LLMModelProvider.CHATGPT_4_ALL,
            ),
        }).bind({
            response_format: { type: 'json_object' },
        });

        const promptGetWorkItemsThemes =
            await this.promptService.getCompleteContextPromptByName(
                'prompt_correlateTeamMembers',
                {
                    organizationAndTeamData,
                    payload: { members: JSON.stringify(members) },
                    promptIsForChat: false,
                },
            );

        const chain = await llm.invoke(promptGetWorkItemsThemes, {
            metadata: {
                module: 'Setup',
                submodule: 'TeamMembers',
            },
        });

        return safelyParseMessageContent(chain.content).members;
    }

    private async buildTeam(
        communicationMembers,
        projectManagementMembers,
        codeManagementMembers,
        membersCorrelated,
    ) {
        const teamMembers = await Promise.all(
            membersCorrelated.map(async (correlation) => {
                const communicationMember = communicationMembers.find(
                    (member) =>
                        member.communicationId === correlation.communication.id,
                );
                const projectManagementMember = projectManagementMembers.find(
                    (member) => member.id === correlation.projectManagement.id,
                );

                const codeManagementMember = codeManagementMembers.find(
                    (member) => member.id === correlation.codeManagement.id,
                );

                let partialMember: Partial<ITeamMember> = {};
                let partialUser: Partial<IUser> = {};

                if (communicationMember) {
                    const foundMember = await this.teamMembersService.findOne({
                        communicationId: communicationMember.communicationId,
                    });

                    if (foundMember) {
                        partialMember = foundMember;
                        if (foundMember.user) {
                            const foundUser = await this.userService.findOne({
                                uuid: foundMember.user.uuid,
                            });
                            if (foundUser) {
                                partialUser = foundUser;
                            }
                        }
                    }
                }

                if (!partialUser.email && projectManagementMember?.email) {
                    const foundUser = await this.userService.findOne({
                        email: projectManagementMember.email,
                    });
                    if (foundUser) {
                        partialUser = foundUser;
                    }
                }

                return {
                    active: true,
                    avatar: communicationMember?.avatar,
                    communicationId: communicationMember?.communicationId,
                    name: communicationMember?.name,
                    teamRole: partialMember.teamRole || [],
                    codeManagement: {
                        id: codeManagementMember?.id,
                        name: codeManagementMember?.name,
                    },
                    projectManagement: {
                        id: projectManagementMember?.id,
                        name: projectManagementMember?.name,
                    },
                    communication: {
                        id: communicationMember?.communicationId,
                        name: communicationMember?.name,
                    },
                    email: partialUser.email || projectManagementMember?.email,
                    userExists:
                        partialUser && partialUser.status === STATUS.ACTIVE,
                };
            }),
        );

        return teamMembers;
    }
}
