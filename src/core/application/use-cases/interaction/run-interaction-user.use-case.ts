import {
    INTERACTION_SERVICE_TOKEN,
    IInteractionService,
} from '@/core/domain/interactions/contracts/interaction.service.contracts';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { Inject } from '@nestjs/common';
import { REQUEST } from '@nestjs/core';
import { Request } from 'express';
import { InteractionDto } from '@/shared/domain/dtos/interaction.dtos';

export class RunInteractionUserUseCase implements IUseCase {
    constructor(
        @Inject(INTERACTION_SERVICE_TOKEN)
        private readonly interactionService: IInteractionService,

        @Inject(REQUEST)
        private readonly request: Request & {
            user: { organization: { uuid: string } };
        },
    ) {}

    public async execute(interaction: InteractionDto): Promise<void> {
        await this.interactionService.createInteraction(interaction);
    }
}
