export type IntegrationSelected = {
    id: string;
    name?: string | undefined;
    key?: string | undefined;
    url?: string | undefined;
    type?: string | undefined;
};

export type SaveIntegrationSelected = {
    userId?: string;
    domainSelected?: IntegrationSelected;
    projectSelected?: IntegrationSelected;
    channelSelected?: IntegrationSelected;
};
