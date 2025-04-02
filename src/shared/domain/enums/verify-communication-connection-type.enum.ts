import { IntegrationCategory } from '@/shared/domain/enums/integration-category.enum';

export type VerifyCommunicationConnectionType = {
    isSetupComplete: boolean;
    hasConnection: boolean;
    config?: object;
    platformName: string;
    category?: IntegrationCategory;
};
