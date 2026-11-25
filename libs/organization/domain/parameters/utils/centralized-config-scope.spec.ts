import {
    centralizedConfigFor,
    withCentralizedConfigFor,
} from './centralized-config-scope';

const github = {
    enabled: true,
    repository: { id: 'r-gh', name: 'acme/config' },
    managedRepositoryIds: ['r-1'],
};
const gitlab = {
    enabled: true,
    repository: { id: 'r-gl', name: 'group/config' },
};

describe('centralized config per Git connection', () => {
    describe('read', () => {
        it('reads the stored config as is when no connection is named', () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(centralizedConfigFor(stored)).toEqual({
                ...github,
                integrationId: 'gh-a',
            });
        });

        it("reads the config of the connection the workspace's stored config belongs to", () => {
            const stored = { ...github, integrationId: 'gh-a' };

            expect(centralizedConfigFor(stored, 'gh-a')).toEqual({
                ...github,
                integrationId: 'gh-a',
            });
        });

        it("reads another connection's own config", () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(centralizedConfigFor(stored, 'gl-b')).toEqual({
                ...gitlab,
                connectionScoped: true,
            });
        });

        it('reads nothing enabled for a connection without a config of its own', () => {
            const stored = { ...github, integrationId: 'gh-a' };

            expect(centralizedConfigFor(stored, 'gl-b')).toEqual({
                enabled: false,
                repository: null,
                connectionScoped: true,
            });
        });

        it('reads a config stored before connections were recorded for any connection', () => {
            expect(centralizedConfigFor(github, 'gh-a')).toEqual(github);
        });
    });

    describe('write', () => {
        it("writes a connection's config beside the workspace's", () => {
            const stored = { ...github, integrationId: 'gh-a' };

            expect(
                withCentralizedConfigFor(stored, 'gl-b', {
                    ...gitlab,
                    connectionScoped: true,
                }),
            ).toEqual({
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            });
        });

        it('writes the config the workspace stored for that connection in place, keeping the others', () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(
                withCentralizedConfigFor(stored, 'gh-a', {
                    enabled: true,
                    repository: { id: 'r-gh2', name: 'acme/config2' },
                    integrationId: 'gh-a',
                }),
            ).toEqual({
                enabled: true,
                repository: { id: 'r-gh2', name: 'acme/config2' },
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            });
        });

        it('records the connection of the first config written', () => {
            expect(withCentralizedConfigFor(undefined, 'gl-b', gitlab)).toEqual(
                {
                    ...gitlab,
                    integrationId: 'gl-b',
                },
            );
        });

        it('keeps the connection a config stored without one is written through', () => {
            expect(withCentralizedConfigFor(github, 'gh-a', github)).toEqual({
                ...github,
                integrationId: 'gh-a',
            });
        });

        it('writes the stored config, keeping the connections, when none is named', () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(
                withCentralizedConfigFor(stored, undefined, {
                    ...github,
                    enabled: false,
                }),
            ).toEqual({
                ...github,
                enabled: false,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            });
        });
        it('forgets the connection of a workspace config that was cleared, so the next connection can take it', () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(
                withCentralizedConfigFor(stored, 'gh-a', {
                    enabled: false,
                    repository: null,
                    activePullRequest: null,
                }),
            ).toEqual({
                enabled: false,
                repository: null,
                activePullRequest: null,
                connections: { 'gl-b': gitlab },
            });
        });

        it("removes a connection's own config once it is cleared", () => {
            const stored = {
                ...github,
                integrationId: 'gh-a',
                connections: { 'gl-b': gitlab },
            };

            expect(
                withCentralizedConfigFor(stored, 'gl-b', {
                    enabled: false,
                    repository: null,
                    activePullRequest: null,
                }),
            ).toEqual({ ...github, integrationId: 'gh-a', connections: {} });
        });
    });
});
