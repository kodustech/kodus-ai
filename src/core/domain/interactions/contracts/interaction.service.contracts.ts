import { InteractionDto } from '@/shared/domain/dtos/interaction.dtos';

export const INTERACTION_SERVICE_TOKEN = Symbol('InteractionService');

export interface IInteractionService {
    createInteraction(interaction: InteractionDto): Promise<void>;
}
