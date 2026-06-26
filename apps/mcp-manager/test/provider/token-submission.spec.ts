import { BadRequestException } from '@nestjs/common';

import { validateTokenSubmission } from '../../src/modules/providers/kodusMCP/token-submission';
import { ManagedAuthMethod } from '../../src/modules/providers/kodusMCP/auth-methods';
import { MCPIntegrationAuthType } from '../../src/modules/integrations/enums/integration.enum';

const jiraTokenMethod: ManagedAuthMethod = {
    id: 'token',
    type: MCPIntegrationAuthType.BASIC,
    userFields: [
        { name: 'email', required: true },
        { name: 'apiToken', required: true, secret: true },
        { name: 'cloudId', required: true },
    ],
};

const linearTokenMethod: ManagedAuthMethod = {
    id: 'token',
    type: MCPIntegrationAuthType.BEARER_TOKEN,
};

describe('validateTokenSubmission', () => {
    it('builds a credential for a valid Jira submission', () => {
        const cred = validateTokenSubmission(jiraTokenMethod, {
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
        });

        expect(cred).toEqual({
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BASIC,
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
        });
    });

    it('builds a bearer credential with no extra fields', () => {
        const cred = validateTokenSubmission(linearTokenMethod, {
            secret: 'lin_api_x',
        });

        expect(cred).toEqual({
            authMethodId: 'token',
            authType: MCPIntegrationAuthType.BEARER_TOKEN,
            secret: 'lin_api_x',
        });
    });

    it('rejects a missing secret', () => {
        expect(() =>
            validateTokenSubmission(jiraTokenMethod, {
                fields: { email: 'dev@kodus.io', cloudId: 'cid-1' },
            }),
        ).toThrow(BadRequestException);
    });

    it('rejects a missing required non-secret field', () => {
        expect(() =>
            validateTokenSubmission(jiraTokenMethod, {
                secret: 'api-token',
                fields: { email: 'dev@kodus.io' },
            }),
        ).toThrow(/cloudId/);
    });

    it('rejects an OAuth method (not a token method)', () => {
        expect(() =>
            validateTokenSubmission(
                { id: 'oauth', type: MCPIntegrationAuthType.OAUTH2 },
                { secret: 'x' },
            ),
        ).toThrow(BadRequestException);
    });

    it('ignores unknown submitted fields not declared on the method', () => {
        const cred = validateTokenSubmission(jiraTokenMethod, {
            secret: 'api-token',
            fields: { email: 'dev@kodus.io', cloudId: 'cid-1', bogus: 'x' },
        });

        expect(cred.fields).toEqual({
            email: 'dev@kodus.io',
            cloudId: 'cid-1',
        });
    });
});
