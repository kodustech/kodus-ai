import { Thread } from '@kodus/flow';
import { Injectable } from '@nestjs/common';

import { ConversationAgentProvider } from '@libs/agents/infrastructure/services/kodus-flow/conversationAgent';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

@Injectable()
export class ConversationAgentUseCase implements IUseCase {
    constructor(
        private readonly conversationAgentProvider: ConversationAgentProvider,
    ) {}

    async execute(context: {
        prompt: string;
        organizationAndTeamData?: OrganizationAndTeamData;
        thread?: Thread;
        prepareContext?: any;
        sandbox?: SandboxInstance;
    }): Promise<any> {
        try {
            const {
                prompt,
                organizationAndTeamData,
                prepareContext,
                thread,
                sandbox,
            } = context;

            return await this.conversationAgentProvider.execute(prompt, {
                organizationAndTeamData,
                prepareContext,
                thread,
                sandbox,
            });
        } catch (error) {
            const errorMessage =
                error instanceof Error ? error.message : String(error);
            throw new Error(`Falha ao processar conversação: ${errorMessage}`, {
                cause: error,
            });
        }
    }
}
