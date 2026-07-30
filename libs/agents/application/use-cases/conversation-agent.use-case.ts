import { Injectable } from '@nestjs/common';

import { ConversationAgentProvider } from '@libs/agents/infrastructure/services/agents/conversationAgent';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { SandboxInstance } from '@libs/sandbox/domain/contracts/sandbox.provider';

/**
 * Thread identifier passed through to the conversation agent. Structurally
 * compatible with the legacy flow engine's `Thread` ({ id, metadata }) but
 * typed locally so this use-case carries no flow-engine dependency.
 */
interface ConversationThread {
    id?: unknown;
    metadata?: Record<string, unknown>;
}

@Injectable()
export class ConversationAgentUseCase implements IUseCase {
    constructor(
        private readonly conversationAgentProvider: ConversationAgentProvider,
    ) {}

    async execute(context: {
        prompt: string;
        organizationAndTeamData?: OrganizationAndTeamData;
        thread?: ConversationThread;
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
