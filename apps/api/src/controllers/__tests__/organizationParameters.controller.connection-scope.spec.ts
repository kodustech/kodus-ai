import { OrganizationParametersController } from '../organizationParameters.controller';

describe('OrganizationParametersController — reads by a member granted some Git connections', () => {
    // The organization's LLM settings hold nothing of any Git connection, so
    // the guard may let them through to such a member.
    it.each(['getLLMConfigStatus', 'getByokProviders'] as const)(
        '%s is marked as needing no narrowing',
        (handler) => {
            expect(
                Reflect.getMetadata(
                    'applies_connection_scope',
                    OrganizationParametersController.prototype[handler],
                ),
            ).toBe(true);
        },
    );
});
