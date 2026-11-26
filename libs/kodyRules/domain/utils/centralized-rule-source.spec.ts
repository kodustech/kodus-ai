import { KodyRuleCentralizedStatus } from '../interfaces/kodyRules.interface';
import {
    centralizedRuleOwner,
    centralizedSourceStamp,
    keepCentralizedSource,
    ruleAppliesToConnection,
    ruleVisibleToConnections,
} from './centralized-rule-source';

const synced = KodyRuleCentralizedStatus.SYNCED;
const source = {
    repositoryId: 'cfg-a',
    connectionId: 'gh-a',
    connectionScoped: false,
};

describe('centralized rule source', () => {
    it("owns another team's copy of the same config repository on the same server", () => {
        expect(
            centralizedRuleOwner(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceServerKey: 'GITHUB|github.com',
                    sourceConnectionId: 'team-a-conn',
                },
                {
                    repositoryId: 'cfg-a',
                    connectionId: 'team-b-conn',
                    serverKey: 'GITHUB|github.com',
                    connectionScoped: false,
                },
            ),
        ).toBe('own');
    });

    it('does not own the same repository id on another server', () => {
        expect(
            centralizedRuleOwner(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: '5',
                    sourceServerKey: 'GITLAB|git.a.io',
                },
                {
                    repositoryId: '5',
                    serverKey: 'GITLAB|git.b.io',
                    connectionScoped: false,
                },
            ),
        ).toBe('other');
    });

    it("does not own another connection's own config, even on the same server", () => {
        expect(
            centralizedRuleOwner(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceServerKey: 'GITHUB|github.com',
                    sourceConnectionId: 'gh-acme',
                    connectionScoped: true,
                },
                {
                    repositoryId: 'cfg-a',
                    connectionId: 'gh-beta',
                    serverKey: 'GITHUB|github.com',
                    connectionScoped: true,
                },
            ),
        ).toBe('other');
    });

    it('stamps the server, and the connection only for a connection-scoped source', () => {
        expect(
            centralizedSourceStamp({
                repositoryId: 'cfg-a',
                connectionId: 'gh-a',
                serverKey: 'GITHUB|github.com',
                connectionScoped: false,
            }),
        ).toEqual({
            sourceRepositoryId: 'cfg-a',
            sourceServerKey: 'GITHUB|github.com',
        });
        expect(
            centralizedSourceStamp({
                repositoryId: 'cfg-b',
                connectionId: 'gl-b',
                serverKey: 'GITLAB|gitlab.com',
                connectionScoped: true,
            }),
        ).toEqual({
            sourceRepositoryId: 'cfg-b',
            sourceServerKey: 'GITLAB|gitlab.com',
            sourceConnectionId: 'gl-b',
            connectionScoped: true,
        });
    });

    it('keeps the server stamp when a writer replaces the centralized fields of the same file', () => {
        expect(
            keepCentralizedSource(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceServerKey: 'GITHUB|github.com',
                },
                { path: 'x.yml', status: synced },
            ),
        ).toEqual({
            path: 'x.yml',
            status: synced,
            sourceRepositoryId: 'cfg-a',
            sourceServerKey: 'GITHUB|github.com',
        });
    });

    it('owns a rule synced from the same config repository', () => {
        expect(
            centralizedRuleOwner(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceConnectionId: 'gh-a',
                },
                source,
            ),
        ).toBe('own');
    });

    it('owns a rule stamped without a connection by the same repository', () => {
        expect(
            centralizedRuleOwner(
                { path: 'x.yml', status: synced, sourceRepositoryId: 'cfg-a' },
                source,
            ),
        ).toBe('own');
    });

    it("does not own another repository's rule, nor the same id on another connection", () => {
        expect(
            centralizedRuleOwner(
                { path: 'x.yml', status: synced, sourceRepositoryId: 'cfg-b' },
                source,
            ),
        ).toBe('other');
        expect(
            centralizedRuleOwner(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceConnectionId: 'gl-b',
                },
                source,
            ),
        ).toBe('other');
    });

    it('reports a rule synced before sources were recorded as unstamped', () => {
        expect(
            centralizedRuleOwner({ path: 'x.yml', status: synced }, source),
        ).toBe('unstamped');
    });

    it('keeps the source when a writer replaces the centralized fields of the same file', () => {
        expect(
            keepCentralizedSource(
                {
                    path: 'x.yml',
                    status: synced,
                    sourceRepositoryId: 'cfg-a',
                    sourceConnectionId: 'gh-a',
                },
                {
                    path: 'x.yml',
                    status: KodyRuleCentralizedStatus.PENDING_DELETE,
                },
            ),
        ).toEqual({
            path: 'x.yml',
            status: KodyRuleCentralizedStatus.PENDING_DELETE,
            sourceRepositoryId: 'cfg-a',
            sourceConnectionId: 'gh-a',
        });
    });

    it('drops the source when the rule moves to another file', () => {
        expect(
            keepCentralizedSource(
                { path: 'x.yml', status: synced, sourceRepositoryId: 'cfg-a' },
                { path: 'y.yml', status: synced },
            ),
        ).toEqual({ path: 'y.yml', status: synced });
    });

    it("applies a connection's global rule only to that connection", () => {
        const rule = {
            repositoryId: 'global',
            centralizedConfig: {
                path: 'x.yml',
                status: synced,
                sourceRepositoryId: 'cfg-b',
                sourceConnectionId: 'gl-b',
                connectionScoped: true,
            },
        };

        expect(ruleAppliesToConnection(rule, 'gl-b')).toBe(true);
        expect(ruleAppliesToConnection(rule, 'gh-a')).toBe(false);
        expect(ruleAppliesToConnection(rule, undefined)).toBe(true);
        expect(
            ruleAppliesToConnection(
                {
                    ...rule,
                    centralizedConfig: {
                        ...rule.centralizedConfig,
                        connectionScoped: false,
                    },
                },
                'gh-a',
            ),
        ).toBe(true);
    });

    it("shows a connection's own global rule only to members granted that connection", () => {
        const scoped = {
            repositoryId: 'global',
            centralizedConfig: {
                path: 'rules/a.yml',
                status: synced,
                sourceRepositoryId: 'cfg-b',
                sourceConnectionId: 'gl-b',
                connectionScoped: true,
            },
        };
        const workspaceWide = {
            repositoryId: 'global',
            centralizedConfig: { path: 'rules/b.yml', status: synced },
        };

        expect(ruleVisibleToConnections(scoped, new Set(['gh-a']))).toBe(false);
        expect(ruleVisibleToConnections(scoped, new Set(['gl-b']))).toBe(true);
        expect(ruleVisibleToConnections(scoped, null)).toBe(true);
        expect(ruleVisibleToConnections(workspaceWide, new Set(['gh-a']))).toBe(
            true,
        );
    });
});
