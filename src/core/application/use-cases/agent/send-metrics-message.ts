import { OrganizationAndTeamData } from '@/config/types/general/organizationAndTeamData';
import {
    AGENT_SERVICE_TOKEN,
    IAgentService,
} from '@/core/domain/agents/contracts/agent.service.contracts';
import {
    IParametersService,
    PARAMETERS_SERVICE_TOKEN,
} from '@/core/domain/parameters/contracts/parameters.service.contract';
import { LanguageValue } from '@/shared/domain/enums/language-parameter.enum';
import { ParametersKey } from '@/shared/domain/enums/parameters-key.enum';
import { Inject, Injectable } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';

@Injectable()
export class SendMetricMessageUseCase {
    constructor(
        @Inject(AGENT_SERVICE_TOKEN)
        private readonly agentService: IAgentService,

        @Inject(PARAMETERS_SERVICE_TOKEN)
        private readonly parametersService: IParametersService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    async execute(params: {
        organizationAndTeamData: OrganizationAndTeamData;
        channelId: string;
    }) {
        const language = await this.parametersService.findByKey(
            ParametersKey.LANGUAGE_CONFIG,
            params.organizationAndTeamData,
        );

        return await this.agentService.sendMetricMessage(
            params.organizationAndTeamData,
            params.channelId,
            language?.configValue ?? LanguageValue.ENGLISH,
        );
    }
}
