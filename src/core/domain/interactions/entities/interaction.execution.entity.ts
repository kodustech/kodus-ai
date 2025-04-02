import { IInteractionExecution } from '../interfaces/interactions-execution.interface';

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export class InteractionExecutionEntity implements IInteractionExecution {
    private readonly _uuid: string;
    private readonly _interactionDate: Date;
    private readonly _platformUserId: string;
    private readonly _interactionType: string;
    private readonly _interactionCommand?: string;
    private readonly _teamId?: string;
    private readonly _organizationId?: string;
    private readonly _buttonLabel?: string;

    constructor(
        interactionExecution:
            | IInteractionExecution
            | Partial<IInteractionExecution>,
    ) {
        this._uuid = interactionExecution.uuid;
        this._interactionDate = interactionExecution.interactionDate;
        this._platformUserId = interactionExecution.platformUserId;
        this._interactionType = interactionExecution.interactionType;
        this._interactionCommand = interactionExecution.interactionCommand;
        this._buttonLabel = interactionExecution.buttonLabel;
        this._teamId = interactionExecution.teamId;
        this._organizationId = interactionExecution.organizationId;
    }

    get uuid(): string {
        return this._uuid;
    }

    get teamId(): string | undefined {
        return this._teamId;
    }

    get interactionDate(): Date {
        return this._interactionDate;
    }

    get platformUserId(): string {
        return this._platformUserId;
    }

    get interactionType(): string {
        return this._interactionType;
    }

    get interactionCommand(): string | undefined {
        return this._interactionCommand;
    }

    get buttonLabel(): string | undefined {
        return this._buttonLabel;
    }

    get organizationId(): string | undefined {
        return this._organizationId;
    }
}
