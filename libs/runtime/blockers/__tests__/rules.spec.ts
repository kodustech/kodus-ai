import { BLOCKER_RULES, classifyBlockerWithRule } from '../catalog';
import { RULE_EXAMPLES } from './fixtures/rule-examples';

// One case per rule of the classifier's registry (catalog.ts BLOCKER_RULES):
// the smallest blocker that rule reads before any other, and the card it gives.

describe('blocker rules', () => {
    describe.each(RULE_EXAMPLES.map((e) => [e.rule, e] as const))('%s', (_id, example) => {
        it(example.behavior, () => {
            const { rule, blocker } = classifyBlockerWithRule(example.input);

            expect(rule).toBe(example.rule);
            expect({ kind: blocker.kind, signature: blocker.signature, fixes: blocker.fixes.map((f) => f.id) }).toEqual(example.card);
        });
    });

    it('has an example for every rule, in the order the classifier tries them', () => {
        expect(RULE_EXAMPLES.map((e) => e.rule)).toEqual(BLOCKER_RULES.map((r) => r.id));
    });

    it('never reads the cause from a log line the app wrote below error level', () => {
        const { rule, blocker } = classifyBlockerWithRule({
            kind: 'unknown',
            signature: 'compose_up',
            message: '',
            bundle: {
                services: [
                    {
                        name: 'api',
                        state: 'running',
                        logTail: ['{"level":"warn","serviceName":"ResendEmailProvider","msg":"RESEND_API_KEY is not set; email sending is disabled"}'],
                    },
                ],
                ports: [],
                disk: [],
                deniedEgress: [],
                redactions: 0,
                truncated: false,
                collectedAt: '2026-11-14T00:00:00.000Z',
            },
        });
        expect(rule).not.toBe('log:missing_env');
        expect(blocker.signature).not.toBe('missing_env:RESEND_API_KEY');
    });

    // A design partner's base build on dev segfaulted in apt; the card read debconf's own note as an env var the app needs.
    it("never reads apt's debconf notes as an env var the app needs", () => {
        const { blocker } = classifyBlockerWithRule({
            kind: 'toolchain',
            signature: 'compose_up',
            message: 'compose up: exit 1',
            bundle: {
                services: [{ name: 'boot output', state: 'failed', logTail: ['#8 574.7 debconf: (TERM is not set, so the dialog frontend is not usable.)', '#8 577.3 Segmentation fault', 'dpkg: error processing package ca-certificates (--configure):'] }],
                ports: [], disk: [], deniedEgress: [], redactions: 0, truncated: false, collectedAt: '2026-11-25T14:36:00.000Z',
            },
        });
        expect(blocker.kind).not.toBe('missing_env');
        expect(blocker.signature).not.toMatch(/TERM/);
    });

    it('names each rule once', () => {
        const ids = BLOCKER_RULES.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
    });

    it('ends with the fallback, which reads a blocker no other rule reads', () => {
        const last = BLOCKER_RULES.at(-1)!;
        expect(last.id).toBe('fallback');
        expect(last.classify({ input: { kind: 'unknown', signature: 'x', message: '' }, lines: [{ text: '' }] })).not.toBeNull();
    });
});
