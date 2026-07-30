import { renderTokenAuthHeaders } from '../../src/modules/integrations/managed-auth-header';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

describe('renderTokenAuthHeaders', () => {
    it('renders a bearer token (Linear / Fireflies)', () => {
        expect(
            renderTokenAuthHeaders({
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.BEARER_TOKEN,
                secret: 'lin_api_abc',
            }),
        ).toEqual({ Authorization: 'Bearer lin_api_abc' });
    });

    it('renders Basic email:token for Jira', () => {
        const headers = renderTokenAuthHeaders({
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BASIC,
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
        });

        const expected = Buffer.from('dev@kodus.io:api-token').toString(
            'base64',
        );
        expect(headers).toEqual({ Authorization: `Basic ${expected}` });
    });

    it('renders an api_key into its configured header', () => {
        expect(
            renderTokenAuthHeaders({
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.API_KEY,
                secret: 'k-123',
                fields: { apiKeyHeader: 'X-MyApp-Key' },
            }),
        ).toEqual({ 'X-MyApp-Key': 'k-123' });
    });

    it('falls back to X-Api-Key when no header name is given', () => {
        expect(
            renderTokenAuthHeaders({
                authMethodId: 'token',
                authType: MCPIntegrationAuthType.API_KEY,
                secret: 'k-123',
            }),
        ).toEqual({ 'X-Api-Key': 'k-123' });
    });

    it('returns no headers for none / oauth2 (handled elsewhere)', () => {
        expect(
            renderTokenAuthHeaders({
                authMethodId: 'oauth',
                authType: MCPIntegrationAuthType.OAUTH2,
                secret: '',
            }),
        ).toEqual({});
    });
});
