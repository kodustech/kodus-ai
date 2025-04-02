export interface IAgentExecution {
    uuid: string;
    agentName: string;
    teamId: string;
    platformUserId?: string;
    platformName?: string;
    message?: string;
    responseMessage?: any;
    sessionId?: string;
    metaData?: Record<string, any>;
}
