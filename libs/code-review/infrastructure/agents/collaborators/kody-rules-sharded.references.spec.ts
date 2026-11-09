import { KodyRuleSummaryService } from '@libs/kodyRules/infrastructure/adapters/services/kody-rule-summary.service';
import { KodyRulesScope } from '@libs/kodyRules/domain/interfaces/kodyRules.interface';
import {
    judgeKodyRulesSharded,
    RunJudge,
    SHARD_PR_SYSTEM_PROMPT,
    SHARD_SYSTEM_PROMPT,
} from './kody-rules-sharded.judge';
import {
    collectLoadedReferences,
    loadRuleSourceReferences,
    mergeRuleReferences,
} from './kody-rules-references';

jest.mock('@libs/core/log/logger', () => {
    const spy = {
        log: jest.fn(),
        error: jest.fn(),
        warn: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    };
    return { createLogger: () => spy };
});

const SOURCE_FILE = `# Conventions\n${'Use the repo logger. '.repeat(400)}`;
const CONTEXT_FILE = 'Context OS convention body';

const file = (filename: string, patch: string): any => ({
    filename,
    status: 'modified',
    patch,
    patchWithLinesStr: patch,
});

const countOf = (text: string, needle: string) => text.split(needle).length - 1;

/** A long rule decomposed into 12 atoms, with a sourcePath and a Context OS reference. */
function expandedRule(scope: KodyRulesScope) {
    const service = new KodyRuleSummaryService({} as any, {} as any, {} as any);
    const parent: any = {
        uuid: 'parent-1',
        title: 'Project conventions',
        rule: 'x'.repeat(1001),
        path: '**/*.ts',
        scope,
        status: 'active',
        examples: [],
        sourcePath: 'CLAUDE.md',
        contextReferenceId: 'ctx-1',
    };
    parent.atoms = {
        items: Array.from({ length: 12 }, (_, i) => ({
            id: `parent-1-atom-${i + 1}`,
            title: `Atom ${i + 1}`,
            spec: `WHAT: condition ${i + 1}`,
        })),
        sourceHash: service.atomsHashOf(parent),
        generatedAt: new Date(),
        model: 'm',
    };
    return service.expandForReview(parent);
}

async function referencesFor(units: any[]) {
    const read = jest.fn().mockResolvedValue(SOURCE_FILE);
    const fromSource = await loadRuleSourceReferences(units, read);
    const fromContext = collectLoadedReferences(
        new Map([
            [
                'parent-1',
                [{ filePath: 'docs/conventions.md', content: CONTEXT_FILE }],
            ],
        ]),
    );
    return { read, references: mergeRuleReferences(fromSource, fromContext) };
}

describe('judgeKodyRulesSharded — a rule decomposed into atoms carries its references once', () => {
    it('prints each referenced file once per file shard, with every atom linked to it', async () => {
        const units = expandedRule(KodyRulesScope.FILE);
        expect(units).toHaveLength(12);
        const { read, references } = await referencesFor(units);
        const prompts: Array<{ system: string; user: string }> = [];
        const run: RunJudge = async ({ system, user }) => {
            prompts.push({ system, user });
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [
                file('src/a.ts', '1 +const a = 1;'),
                file('src/b.ts', '1 +const b = 2;'),
            ],
            rules: units,
            runJudge: run,
            references,
        });

        expect(read).toHaveBeenCalledTimes(1);
        expect(prompts).toHaveLength(2);
        for (const { system, user } of prompts) {
            expect(countOf(user, '# Conventions')).toBe(1);
            expect(countOf(user, CONTEXT_FILE)).toBe(1);
            expect(countOf(user, '  references: R1, R2')).toBe(12);
            expect(user.indexOf('</Rules>')).toBeLessThan(
                user.indexOf('<References>'),
            );
            expect(system.startsWith(SHARD_SYSTEM_PROMPT)).toBe(true);
            expect(system).toContain('references:');
        }
    });

    it('prints each referenced file once in the PR-scope shard', async () => {
        const units = expandedRule(KodyRulesScope.PULL_REQUEST);
        const { references } = await referencesFor(units);
        const prompts: Array<{ system: string; user: string }> = [];
        const run: RunJudge = async ({ system, user }) => {
            prompts.push({ system, user });
            return [];
        };

        await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +const a = 1;')],
            rules: units,
            runJudge: run,
            references,
        });

        expect(prompts).toHaveLength(1);
        expect(countOf(prompts[0].user, '# Conventions')).toBe(1);
        expect(countOf(prompts[0].user, CONTEXT_FILE)).toBe(1);
        expect(countOf(prompts[0].user, '  references: R1, R2')).toBe(12);
        expect(prompts[0].system.startsWith(SHARD_PR_SYSTEM_PROMPT)).toBe(true);
        expect(prompts[0].system).toContain('references:');
    });

    it('cuts every copy of a file at the same point', async () => {
        const units = expandedRule(KodyRulesScope.FILE);
        const { references } = await referencesFor(units);
        const entries = new Set(
            units.flatMap((u) =>
                (references.get(u.uuid!) ?? []).map((r) => r.content),
            ),
        );
        expect(entries.size).toBe(2);
    });

    it('leaves the prompts of rules without references unchanged', async () => {
        const rules = [{ uuid: 'r1', title: 't', rule: 'r', path: '**/*.ts' }];
        const capture = async (references?: Map<string, any[]>) => {
            const prompts: Array<{ system: string; user: string }> = [];
            await judgeKodyRulesSharded({
                changedFiles: [file('src/a.ts', '1 +const a = 1;')],
                rules,
                runJudge: async ({ system, user }) => {
                    prompts.push({ system, user });
                    return [];
                },
                references,
            });
            return prompts[0];
        };

        const without = await capture(undefined);
        const unrelated = await capture(
            new Map([
                [
                    'someone-else',
                    [{ source: 'rule-source', filePath: 'x', content: 'y' }],
                ],
            ]),
        );

        expect(without.system).toBe(SHARD_SYSTEM_PROMPT);
        expect(without.user).not.toContain('<References>');
        expect(without.user).not.toContain('references:');
        expect(unrelated).toEqual(without);
    });

    it('drops a finding that names a reference id instead of a rule number', async () => {
        const units = expandedRule(KodyRulesScope.FILE);
        const { references } = await referencesFor(units);

        const { violations } = await judgeKodyRulesSharded({
            changedFiles: [file('src/a.ts', '1 +const a = 1;')],
            rules: units,
            runJudge: async () => [
                {
                    ruleId: 'R1' as any,
                    relevantLinesStart: 1,
                    relevantLinesEnd: 1,
                    suggestionContent: 'x',
                    improvedCode: 'const a = 2;',
                },
            ],
            references,
        });

        expect(violations).toHaveLength(0);
    });
});
