export type MSTeamsInstallationApp = {
    serviceUrl: string;
    conversationType: 'personal' | 'groupChat' | 'channel';
    conversationId: string;
    msTeamsUserId: string;
};
