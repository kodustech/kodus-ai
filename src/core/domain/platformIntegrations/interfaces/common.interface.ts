export interface ICommonPlatformIntegrationService {
    createAuthIntegration(params: any): Promise<any>;
    updateAuthIntegration(params: any): Promise<any>;
    createOrUpdateIntegrationConfig(params: any): Promise<any>;
}
