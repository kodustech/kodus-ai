import { IAgentExecution } from '../interfaces/agent-execution.interface';

export class AgentExecutionEntity implements IAgentExecution {
    private _uuid: string;
    private _agentName: string;
    private _teamId: string;
    private _platformUserId?: string;
    private _platformName?: string;
    private _message?: string;
    private _responseMessage?: string;
    private _sessionId?: string;
    private _metaData?: Record<string, any>;

    constructor(agentExecution: IAgentExecution | Partial<IAgentExecution>) {
        this._uuid = agentExecution.uuid;
        this._agentName = agentExecution.agentName;
        this._teamId = agentExecution.teamId;
        this._platformUserId = agentExecution.platformUserId;
        this._platformName = agentExecution.platformName;
        this._message = agentExecution.message;
        this._responseMessage = agentExecution.responseMessage;
        this._sessionId = agentExecution.sessionId;
        this._metaData = agentExecution.metaData;
    }

    static create(agentExecution: IAgentExecution | Partial<IAgentExecution>) {
        return new AgentExecutionEntity(agentExecution);
    }

    get uuid(): string {
        return this._uuid;
    }

    get agentName(): string {
        return this._agentName;
    }

    get teamId(): string {
        return this._teamId;
    }

    get platformUserId(): string | undefined {
        return this._platformUserId;
    }

    get platformName(): string | undefined {
        return this._platformName;
    }

    get message(): string | undefined {
        return this._message;
    }

    get responseMessage(): any | undefined {
        return this._responseMessage;
    }

    get sessionId(): string | undefined {
        return this._sessionId;
    }

    get metaData(): Record<string, any> | undefined {
        return this._metaData;
    }
}
