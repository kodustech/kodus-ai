export interface SSOConfig {
    enabled: boolean;
    issuer: string;
    clientId: string;
    clientSecret: string;
    redirectUris: string[];
    domains: string[];
}
