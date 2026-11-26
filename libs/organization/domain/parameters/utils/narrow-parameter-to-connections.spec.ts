import { ParametersKey } from '@libs/core/domain/enums/parameters-key.enum';

import { narrowParameterToConnections } from './narrow-parameter-to-connections';

const restriction = {
    connectionIds: new Set(['gh-a']),
    repositoryIds: new Set(['1']),
    allowsRepository: ({ id }: { id?: unknown }) => String(id) === '1',
};

describe('narrowParameterToConnections', () => {
    it("keeps only the granted repositories' review settings", () => {
        const parameter = {
            configKey: ParametersKey.CODE_REVIEW_CONFIG,
            configValue: {
                configs: { reviewMode: 'safe' },
                repositories: [
                    { id: '1', name: 'api', configs: {} },
                    { id: '2', name: 'web', configs: {} },
                ],
            },
        };

        const narrowed = narrowParameterToConnections(
            ParametersKey.CODE_REVIEW_CONFIG,
            parameter,
            restriction,
        );

        expect(narrowed.configValue.repositories).toEqual([
            { id: '1', name: 'api', configs: {} },
        ]);
        expect(narrowed.configValue.configs).toEqual({ reviewMode: 'safe' });
        // The cached original stays whole.
        expect(parameter.configValue.repositories).toHaveLength(2);
    });

    it("keeps only the granted connections' own centralized configs", () => {
        const narrowed = narrowParameterToConnections(
            ParametersKey.CENTRALIZED_CONFIG,
            {
                configValue: {
                    enabled: true,
                    connections: {
                        'gh-a': { enabled: true },
                        'gl-b': { enabled: true },
                    },
                },
            },
            restriction,
        );

        expect(Object.keys(narrowed.configValue.connections)).toEqual(['gh-a']);
    });

    it('leaves the parameter whole for a member granted every connection, and other keys as they are', () => {
        const parameter = { configValue: { repositories: [{ id: '2' }] } };

        expect(
            narrowParameterToConnections(
                ParametersKey.CODE_REVIEW_CONFIG,
                parameter,
                null,
            ),
        ).toBe(parameter);
        expect(
            narrowParameterToConnections(
                ParametersKey.PLATFORM_CONFIGS,
                parameter,
                restriction,
            ),
        ).toBe(parameter);
    });
});
