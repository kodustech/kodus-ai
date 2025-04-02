export const MSTEAMS_SERVICE_TOKEN = Symbol('MSTeamsService');

export interface IMSTeamsService {
    installBotInTeamMembers(params: any): Promise<any>;
    getTeamsStoryUrl();
    sendMessageToMemberID(params: any): Promise<any>;
}
