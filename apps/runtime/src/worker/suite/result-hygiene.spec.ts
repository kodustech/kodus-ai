import type { SpecResult } from '@libs/runtime/suite';

import type { Canary } from '../canary/canary';
import { cleanSpecResult, MAX_ATTEMPTS_PER_TEST, MAX_TESTS_PER_SPEC, MAX_TITLE_CHARS } from './result-hygiene';

// A test's title and failure message are written by the customer's code: a secret it printed, or the Run's canary, must
// never reach the results table, the suite view or the GitHub check. AWS's documented example key stands for a secret.
const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE';
const canary: Canary = { slot: 'npmrc', value: '//registry.example/:_authToken=kdcanary-9f8e7d6c5b4a3210', core: '9f8e7d6c5b4a3210' };
const result = (over: Partial<SpecResult> = {}): SpecResult => ({
    spec: 'e2e/cart.spec.js',
    status: 'failed',
    durationMs: 10,
    tests: [{ title: 'adds an item', status: 'failed', attempts: [{ status: 'failed', ms: 5, error: `request with aws_access_key_id = ${AWS_KEY} failed` }] }],
    errorSignature: `request with aws_access_key_id = ${AWS_KEY} failed`,
    ...over,
});

describe('a spec result from the runner, before anything stores it', () => {
    it('redacts a secret in a failure message and in the error signature, and keeps the rest of the text', () => {
        const { result: out, leaked } = cleanSpecResult(result(), []);
        expect(JSON.stringify(out)).not.toContain(AWS_KEY);
        expect(out.tests[0].attempts[0].error).toContain('failed');
        expect(leaked).toBe(false);
    });

    it('says a canary in a title or an error leaked, and stores it redacted', () => {
        const { result: out, leaked } = cleanSpecResult(result({ tests: [{ title: `uses ${canary.value}`, status: 'passed', attempts: [{ status: 'passed', ms: 1 }] }] }), [canary]);
        expect(leaked).toBe(true);
        expect(JSON.stringify(out)).not.toContain(canary.core);
    });

    it('bounds what one result file can store: tests per spec (every failed test kept), title length and tries per test', () => {
        const many = Array.from({ length: MAX_TESTS_PER_SPEC + 50 }, (_, i) => ({ title: `t${i}`, status: 'passed' as const, attempts: [{ status: 'passed' as const, ms: 1 }] }));
        many.push({ title: 'the one that failed', status: 'failed' as never, attempts: [{ status: 'failed', ms: 1 }] as never });
        const { result: out } = cleanSpecResult(result({ tests: many }), []);
        expect(out.tests).toHaveLength(MAX_TESTS_PER_SPEC);
        expect(out.tests.some((t) => t.title === 'the one that failed')).toBe(true);
        const long = cleanSpecResult(result({ tests: [{ title: 'x'.repeat(5_000), status: 'failed', attempts: Array.from({ length: 40 }, () => ({ status: 'failed' as const, ms: 1 })) }] }), []).result;
        expect(long.tests[0].title).toHaveLength(MAX_TITLE_CHARS);
        expect(long.tests[0].attempts).toHaveLength(MAX_ATTEMPTS_PER_TEST);
    });
});
