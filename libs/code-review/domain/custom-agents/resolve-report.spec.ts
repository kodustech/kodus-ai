import {
    countAstGrepRules,
    isKodyRuleSource,
    knowledgeBudgets,
} from './resolve-report';
import {
    astGrepRulesPath,
    CUSTOM_AGENT_LIMITS,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';

describe('astGrepRulesPath', () => {
    it.each([
        ['rules/no-console.yml', 'rules/no-console.yml'],
        ['  .ast-grep/rules.yaml\n', '.ast-grep/rules.yaml'],
        ['sgrules.YML', 'sgrules.YML'],
    ])('reads %j as a repository path', (value, path) => {
        expect(astGrepRulesPath(value)).toBe(path);
    });

    it.each([
        [undefined],
        [''],
        ['id: no-console\nlanguage: ts\nrule:\n  pattern: console.log($A)'],
        ['id: rules.yml'],
        ['rules/no-console.ts'],
        ['my rules.yml'],
    ])('reads %j as inline rules, not a path', (value) => {
        expect(astGrepRulesPath(value)).toBeUndefined();
    });
});

describe('custom agent resolve report', () => {
    it('counts one ast-grep rule per YAML document', () => {
        const report = countAstGrepRules(
            [
                'id: no-float-money',
                'language: typescript',
                'rule: { pattern: "parseFloat($AMOUNT)" }',
                '---',
                'id: ledger-balance',
                'language: typescript',
                'rule: { pattern: "post($ENTRY)" }',
            ].join('\n'),
        );

        expect(report).toEqual({
            ruleCount: 2,
            ruleIds: ['no-float-money', 'ledger-balance'],
            errors: [],
        });
    });

    it('reports documents without an id or a rule instead of counting them', () => {
        const report = countAstGrepRules(
            'language: typescript\n---\nid: half-rule\nlanguage: go',
        );

        expect(report.ruleCount).toBe(0);
        expect(report.errors).toEqual([
            'Rule 1 has no id.',
            'Rule "half-rule" has no rule pattern.',
        ]);
    });

    it('reports rules over the size the tool runs instead of counting them', () => {
        const rule = 'id: r\nlanguage: ts\nrule: { pattern: x }\n---\n';
        const source = rule.repeat(
            Math.ceil(CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes / rule.length) +
                1,
        );
        const report = countAstGrepRules(source);
        expect(report.ruleCount).toBe(0);
        expect(report.ruleIds).toEqual([]);
        expect(report.errors).toEqual([
            `The rules are ${Buffer.byteLength(source)} bytes; ast-grep runs at most ${CUSTOM_AGENT_LIMITS.maxAstGrepRuleBytes}.`,
        ]);
    });

    it('reports YAML that does not parse', () => {
        expect(countAstGrepRules('id: [unclosed').errors[0]).toMatch(
            /^Not valid YAML/,
        );
    });

    it('sums skills, docs and doc tokens per target and flags each limit', () => {
        const docs = Array.from({ length: 11 }, (_, index) => ({
            path: `docs/ledger-${index}.md`,
            kind: 'doc' as const,
            linkedTo: [{ agentId: 'ledger-agent' }],
        }));
        const budgets = knowledgeBudgets(
            [
                ...docs,
                {
                    path: 'skills/posting/SKILL.md',
                    kind: 'skill',
                    linkedTo: ['main-review', { agentId: 'ledger-agent' }],
                },
            ],
            docs.map((doc) => ({
                path: doc.path,
                kind: 'doc',
                found: true,
                issues: [],
                tokens: 2000,
            })),
        );

        expect(budgets).toEqual([
            {
                target: 'agent:ledger-agent',
                skills: 1,
                docs: 11,
                docTokens: 22000,
                over: ['docs', 'docTokens'],
            },
            {
                target: 'main-review',
                skills: 1,
                docs: 0,
                docTokens: 0,
                over: [],
            },
        ]);
    });

    it('recognises files that are already Kody Rules sources', () => {
        expect(isKodyRuleSource('AGENTS.md')).toBe(true);
        expect(isKodyRuleSource('services/ledger/CLAUDE.md')).toBe(true);
        expect(isKodyRuleSource('docs/ledger-guide.md')).toBe(false);
    });
});
