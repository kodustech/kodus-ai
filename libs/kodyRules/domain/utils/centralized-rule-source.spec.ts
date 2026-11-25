import { KodyRuleCentralizedStatus } from '../interfaces/kodyRules.interface';
import {
    centralizedRuleOwner,
    keepCentralizedSource,
    ruleAppliesToConnection,
} from './centralized-rule-source';

const synced = KodyRuleCentralizedStatus.SYNCED;
const source = {
    repositoryId: 'cfg-a',
    connectionId: 'gh-a',
    connectionScoped: false,
};

describe('centralized rule source', () => {
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
});
