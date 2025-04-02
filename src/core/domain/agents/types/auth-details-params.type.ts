export type AuthDetailsParams = {
    authIntegration?: {
        identifierKey: string;
        identifierValue: string;
    };
    integrationConfig?: {
        identifierKey: string;
        identifierValue: string;
    };
    userCommunicationData?: {
        communicationId: string;
        userName?: string;
    };
};
