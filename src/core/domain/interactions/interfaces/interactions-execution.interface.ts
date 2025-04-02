export interface IInteractionExecution {
    uuid?: string;
    interactionDate: Date;
    platformUserId: string;
    interactionType: string; // 'chat' or 'button'
    interactionCommand?: string; // Command typed for chat interactions
    buttonLabel?: string; // Button text for button interactions
    teamId: string;
    organizationId: string;
}
