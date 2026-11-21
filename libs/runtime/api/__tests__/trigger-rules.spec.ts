import { decideRun, compileGlob, parseTriggerRules, type RepositoryTriggerSettings } from '../domain/trigger-rules';

const pr = (patch: Partial<Parameters<typeof decideRun>[1]> = {}) => ({
    changedPaths: ['db/migrations/0042_add_status.sql', 'src/orders/orders.service.ts'],
    labels: ['payments'],
    authorIsAgent: false,
    isNewPush: false,
    ...patch,
});

const rules = (patch: Partial<RepositoryTriggerSettings> = {}): RepositoryTriggerSettings => ({
    mode: 'rules',
    rules: [{ conditions: [{ field: 'changed_paths', matches: 'db/migrations/**' }] }],
    runOnAgentPullRequests: false,
    runOnNewPushes: false,
    ...patch,
});

describe('compileGlob', () => {
    it('** crosses folders, * does not, ? is one character, dots are literal', () => {
        expect(compileGlob('db/migrations/**').test('db/migrations/0042.sql')).toBe(true);
        expect(compileGlob('db/migrations/**').test('db/migrations/a/b.sql')).toBe(true);
        expect(compileGlob('src/*.ts').test('src/a/b.ts')).toBe(false);
        expect(compileGlob('**/*.sql').test('db/x.sql')).toBe(true);
        expect(compileGlob('**/*.sql').test('x.sql')).toBe(true);
        expect(compileGlob('a?.ts').test('ab.ts')).toBe(true);
        expect(compileGlob('a.ts').test('abts')).toBe(false);
        expect(compileGlob('src/**/x.ts').test('src/x.ts')).toBe(true);
        expect(compileGlob('src/**/x.ts').test('src/a/b/x.ts')).toBe(true);
        expect(compileGlob('src/**/x.ts').test('srcx.ts')).toBe(false);
    });

    // The old regular expression, as an oracle on inputs short enough for it.
    const oracle = (glob: string) => {
        let out = '';
        for (let i = 0; i < glob.length; i++) {
            const c = glob[i];
            if (c === '*') {
                if (glob[i + 1] === '*') {
                    i++;
                    if (glob[i + 1] === '/') {
                        i++;
                        out += '(?:.*/)?';
                    } else out += '.*';
                } else out += '[^/]*';
            } else if (c === '?') out += '[^/]';
            else out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
        return new RegExp(`^${out}$`);
    };

    it('agrees with the regular-expression semantics on random globs and paths', () => {
        let seed = 42;
        const rnd = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
        const pick = (alphabet: string[], len: number) => Array.from({ length: len }, () => alphabet[rnd(alphabet.length)]).join('');
        for (let i = 0; i < 4_000; i++) {
            const glob = pick(['a', 'b', '/', '*', '**', '**/', '?', '.'], 1 + rnd(6));
            const path = pick(['a', 'b', '/', '.'], rnd(9));
            expect([glob, path, compileGlob(glob).test(path)]).toEqual([glob, path, oracle(glob).test(path)]);
        }
    });

    it('is linear: a glob that made the regular expression backtrack for seconds answers at once', () => {
        const started = Date.now();
        const glob = '*a*a*a*a*a*a*a*a*a*a*a*a*ab';
        expect(compileGlob(glob).test('a'.repeat(200))).toBe(false);
        expect(compileGlob(`**/${glob}`).test(`${'a/'.repeat(100)}${'a'.repeat(200)}`)).toBe(false);
        expect(Date.now() - started).toBeLessThan(200);
    });
});

describe('parseTriggerRules', () => {
    it('keeps the three condition kinds and refuses anything else', () => {
        const ok = parseTriggerRules([
            { conditions: [{ field: 'label', includes: ' payments ' }, { field: 'changed_paths', matches: 'src/payments/**' }] },
            { conditions: [{ field: 'files_changed', moreThan: 30 }] },
        ]);
        expect(ok).toEqual({
            ok: true,
            rules: [
                { conditions: [{ field: 'label', includes: 'payments' }, { field: 'changed_paths', matches: 'src/payments/**' }] },
                { conditions: [{ field: 'files_changed', moreThan: 30 }] },
            ],
        });
        for (const bad of [{}, [{ conditions: [] }], [{ conditions: [{ field: 'author', is: 'x' }] }], [{ conditions: [{ field: 'files_changed', moreThan: -1 }] }]]) {
            expect(parseTriggerRules(bad).ok).toBe(false);
        }
        expect(parseTriggerRules(Array.from({ length: 21 }, () => ({ conditions: [{ field: 'label', includes: 'x' }] }))).ok).toBe(false);
    });
});

describe('decideRun (screen 2: when it runs)', () => {
    it('off never runs; on request waits for @kody runtime', () => {
        expect(decideRun(rules({ mode: 'off' }), pr())).toEqual({ run: false, reason: 'off' });
        expect(decideRun(rules({ mode: 'on_request' }), pr())).toEqual({ run: false, reason: 'on_request_only' });
    });

    it('rules: any rule whose conditions all hold runs the PR', () => {
        expect(decideRun(rules(), pr())).toEqual({ run: true, rule: 0 });
        const both = rules({ rules: [{ conditions: [{ field: 'label', includes: 'Payments' }, { field: 'changed_paths', matches: 'src/payments/**' }] }] });
        expect(decideRun(both, pr())).toEqual({ run: false, reason: 'rule_not_matched' });
        expect(decideRun(both, pr({ changedPaths: ['src/payments/refund.ts'] }))).toEqual({ run: true, rule: 0 });
        const many = rules({ rules: [{ conditions: [{ field: 'files_changed', moreThan: 1 }] }] });
        expect(decideRun(many, pr())).toEqual({ run: true, rule: 0 });
        expect(decideRun(rules({ rules: [] }), pr())).toEqual({ run: false, reason: 'rule_not_matched' });
    });

    it('PRs of coding agents and new pushes run only when switched on', () => {
        expect(decideRun(rules(), pr({ authorIsAgent: true }))).toEqual({ run: false, reason: 'bot_author' });
        expect(decideRun(rules({ runOnAgentPullRequests: true }), pr({ authorIsAgent: true }))).toEqual({ run: true, rule: 0 });
        expect(decideRun(rules(), pr({ isNewPush: true }))).toEqual({ run: false, reason: 'new_pushes_off' });
        expect(decideRun(rules({ runOnNewPushes: true }), pr({ isNewPush: true }))).toEqual({ run: true, rule: 0 });
    });
});
