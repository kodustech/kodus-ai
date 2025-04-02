import {
    IIntegrationService,
    INTEGRATION_SERVICE_TOKEN,
} from '@/core/domain/integrations/contracts/integration.service.contracts';
import { Inject, Injectable } from '@nestjs/common';
import * as prompts from '@/shared/utils/langchainCommon/prompts';
import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';
import {
    ChatPromptTemplate,
    HumanMessagePromptTemplate,
    MessagesPlaceholder,
} from '@langchain/core/prompts';
import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    ITeamService,
    TEAM_SERVICE_TOKEN,
} from '@/core/domain/team/contracts/team.service.contract';
import {
    IIntegrationConfigService,
    INTEGRATION_CONFIG_SERVICE_TOKEN,
} from '@/core/domain/integrationConfigs/contracts/integration-config.service.contracts';
import { IntegrationConfigKey } from '@/shared/domain/enums/Integration-config-key.enum';
import { IParametersService, PARAMETERS_SERVICE_TOKEN } from '@/core/domain/parameters/contracts/parameters.service.contract';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';

const platformDataDictionary = {
    JIRA: 'Issues, changelogs, board columns',
    AZURE_REPOS: '',
    SLACK: {
        instruction: `
    - SLACK.

    Instructions:
    For words or phrases in bold, always use just one asterisk instead of two. Examples:
    --
    Ready To Deploy
    Bold: *Ready To Deploy*

    GE-158
    Bold: *GE-158*

    1. Revisar o processo de QA
    Bold: 1. *Revisar o processo de QA*

    How many tasks are currently in the Ready To Deploy column?
    Bold: *How many tasks are currently in the Ready To Deploy column?*`,
    },
    DISCORD: {
        instruction: `
    - DISCORD (Always keep response under 2000 characters).

    Instructions:
    For words or phrases in bold, always use just one asterisk instead of two. Examples:
    --
    Ready To Deploy
    Bold: **Ready To Deploy**

    GE-158
    Bold: **GE-158**

    1. Revisar o processo de QA
    Bold: 1. **Revisar o processo de QA**

    How many tasks are currently in the Ready To Deploy column?
    Bold: **How many tasks are currently in the Ready To Deploy column?**`,
    },
    TEAMS: 'Issues, changelogs, board columns',
    GITHUB: 'PRs',
};

@Injectable()
export class PromptService {
    constructor(
        @Inject(INTEGRATION_SERVICE_TOKEN)
        private readonly integrationService: IIntegrationService,

        @Inject(INTEGRATION_CONFIG_SERVICE_TOKEN)
        private readonly integrationConfigService: IIntegrationConfigService,

        @Inject(TEAM_SERVICE_TOKEN)
        private readonly teamService: ITeamService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService
    ) { }

    getPromptByName(name: string): any {
        if (name in prompts) {
            return prompts[name];
        }

        throw new Error(`Prompt named "${name}" not found.`);
    }

    async getCompleteContextPromptByName(
        name: string,
        config: {
            organizationAndTeamData: OrganizationAndTeamData;
            promptIsForChat?: boolean;
            payload?: any;
        },
    ): Promise<ChatPromptTemplate<any, any>> {
        config.promptIsForChat = config.promptIsForChat ?? true;

        const promptExecute = this.getPromptByName(name);
        const kodyContext = await this.getKodyContextPrompt(
            config.organizationAndTeamData,
        );

        return this.composePrompts(kodyContext, promptExecute, config);
    }

    private async getKodyContextPrompt(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<any> {
        const formattedPlatformsInput = await this.generateInputPlatformSummary(
            organizationAndTeamData,
        );

        const formattedPlatformsOutput =
            await this.generateOutputPlatformSummary(organizationAndTeamData);

        const teamConfiguration = await this.generateTeamConfiguration(
            organizationAndTeamData,
        );

        const promptFunction = this.getPromptByName('prompt_kodyContext');

        const language = (
            await this.parametersService.findByKey(
                ParametersKey.LANGUAGE_CONFIG,
                organizationAndTeamData,
            )
        )?.configValue;

        const prompt = await promptFunction(
            formattedPlatformsInput,
            formattedPlatformsOutput,
            teamConfiguration,
            language
        );

        return prompt;
    }

    private async composePrompts(
        kodyContext: string,
        prompt: any,
        config: any,
    ): Promise<ChatPromptTemplate<any, any>> {
        let chatPrompt;

        if (config.promptIsForChat) {
            const promptReplace = prompt.replace(
                '{prompt_kodyContext}',
                kodyContext,
            );

            chatPrompt = await ChatPromptTemplate.fromMessages([
                ['system', promptReplace],
                new MessagesPlaceholder('history'),
                HumanMessagePromptTemplate.fromTemplate('{input}'),
            ]);
        } else {
            const promptExecute = prompt(config?.payload);

            const promptReplace = promptExecute.replace(
                '{prompt_kodyContext}',
                kodyContext,
            );

            return promptReplace;
        }

        return chatPrompt;
    }

    private async generateInputPlatformSummary(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const platforms = await this.integrationService.getConnections({
            organizationAndTeamData,
        });

        const filteredPlatforms = platforms.filter(
            (platform) =>
                platform.category !== IntegrationCategory.COMMUNICATION,
        );

        return this.formatPlatformData(filteredPlatforms);
    }

    private async generateOutputPlatformSummary(
        organizationAndTeamData: OrganizationAndTeamData,
    ): Promise<string> {
        const platforms = await this.integrationService.getConnections({
            organizationAndTeamData,
        });

        const filteredPlatforms = platforms.filter(
            (platform) =>
                platform.category === IntegrationCategory.COMMUNICATION,
        );

        return this.formatPlatformData(filteredPlatforms);
    }

    private async generateTeamConfiguration(
        organizationAndTeamData: OrganizationAndTeamData,
    ) {
        const team = await this.teamService.findOne({
            organization: { uuid: organizationAndTeamData.organizationId },
            uuid: organizationAndTeamData.teamId,
        });

        const methodology =
            await this.integrationConfigService.findIntegrationConfigFormatted<string>(
                IntegrationConfigKey.TEAM_PROJECT_MANAGEMENT_METHODOLOGY,
                organizationAndTeamData,
            );

        return {
            teamName: team?.name,
            methodology,
        };
    }

    private formatPlatformData(platforms: any[]): string {
        const platformDataList: string[] = platforms.map((platform) => {
            const data = platformDataDictionary[platform.platformName];

            if (
                typeof data === 'object' &&
                data.hasOwnProperty('instruction')
            ) {
                return data.instruction;
            } else {
                return `- ${platform.platformName}: ${data || ''}`;
            }
        });

        return platformDataList.join('\n');
    }
}
