export type SlackAuthDetail = {
    botToken: string;
    authToken: string;
    slackTeamId: string;
    botInfo?: BotInfo;
};

export type BotInfo = {
    botUserId: string;
    botId: string;
    name: string;
};
