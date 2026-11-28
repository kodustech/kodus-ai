import { createHash } from 'crypto';
import { ruleCompileHash } from './compile-hash';

describe('ruleCompileHash', () => {
    const rule = 'Use the logger';
    const bad = { snippet: 'console.log(x)', isCorrect: false };
    const good = { snippet: 'logger.info(x)', isCorrect: true };

    it('gives CLI and web examples the same hash as a stored web compile attempt', () => {
        const web = [bad, good];
        const cli = web.map(({ snippet, isCorrect }) => ({
            isCorrect,
            snippet,
        }));
        const stored = createHash('sha256')
            .update(`${rule} ${JSON.stringify(web)}`)
            .digest('hex');

        expect(ruleCompileHash({ rule, examples: web })).toBe(stored);
        expect(ruleCompileHash({ rule, examples: cli })).toBe(stored);
    });

    it.each([
        ['snippet', [{ ...bad, snippet: 'console.warn(x)' }, good]],
        ['label', [{ ...bad, isCorrect: true }, good]],
        ['example order', [good, bad]],
    ] as const)('changes when the %s changes', (_name, examples) => {
        expect(ruleCompileHash({ rule, examples: [...examples] })).not.toBe(
            ruleCompileHash({ rule, examples: [bad, good] }),
        );
    });
});

describe('DETECTOR_COMPILER_VERSION in ruleCompileHash', () => {
    const VERSION_MODULE =
        '@libs/code-review/infrastructure/agents/collaborators/kody-rules-detector.compiler-version';
    const input = {
        rule: 'Use the logger',
        examples: [{ snippet: 'console.log(x)', isCorrect: false }],
    };
    // Exactly what PR #2754 stored, before the version existed.
    const storedBeforeVersion = createHash('sha256')
        .update(`${input.rule} ${JSON.stringify(input.examples)}`)
        .digest('hex');
    const attempt = (sourceHash: string) => ({
        ...input,
        compileAttempt: { sourceHash, outcome: 'declined' as const },
    });

    function withVersion(version: number): typeof import('./compile-hash') {
        let mod: typeof import('./compile-hash');
        jest.isolateModules(() => {
            jest.doMock(VERSION_MODULE, () => ({
                DETECTOR_COMPILER_VERSION: version,
            }));
            mod = require('./compile-hash');
        });
        jest.dontMock(VERSION_MODULE);
        return mod!;
    }

    it('deploying version 1 keeps every stored attempt current (no mass recompile)', () => {
        const { ruleCompileHash, compileAttemptIsCurrent } = withVersion(1);
        expect(ruleCompileHash(input)).toBe(storedBeforeVersion);
        expect(compileAttemptIsCurrent(attempt(storedBeforeVersion))).toBe(
            true,
        );
    });

    it('a bump changes the hash and makes stored attempts stale once', () => {
        const { ruleCompileHash, compileAttemptIsCurrent } = withVersion(2);
        expect(ruleCompileHash(input)).not.toBe(storedBeforeVersion);
        expect(compileAttemptIsCurrent(attempt(storedBeforeVersion))).toBe(
            false,
        );
        // The recompile records the new hash, which then settles the rule.
        expect(compileAttemptIsCurrent(attempt(ruleCompileHash(input)))).toBe(
            true,
        );
    });

    it('a bump still recognizes a legacy cosmetic decline, so the recheck runs', () => {
        const { wasDeclinedByLegacyCosmeticGate } = withVersion(2);
        expect(
            wasDeclinedByLegacyCosmeticGate({
                ...input,
                compileAttempt: {
                    sourceHash: storedBeforeVersion,
                    outcome: 'declined',
                    declineReason: 'cosmetic',
                },
            }),
        ).toBe(true);
    });
});

/**
 * The gate that decides whether an EXISTING rule is ever re-classified.
 *
 * A stored context need is a function of the rule's text AND the prompt that
 * classified it, but the key only ever covered the text. That was invisible
 * until the prompt turned out to be wrong: it told the classifier the judge
 * sees the whole file, so "no unused imports", "functions must not exceed 40
 * lines" and "every class has a docstring" were answered `diff-only`. Without
 * the version in the key, every rule of that family in the installed base keeps
 * that verdict forever and the fix reaches only rules created after the deploy.
 */
describe('ruleContextNeedHash', () => {
    const { ruleContextNeedHash } =
        require('./compile-hash') as typeof import('./compile-hash');

    it('is stable for the same text and version', () => {
        expect(ruleContextNeedHash({ rule: 'no unused imports' })).toBe(
            ruleContextNeedHash({ rule: 'no unused imports' }),
        );
    });

    it('changes when the rule text changes', () => {
        expect(ruleContextNeedHash({ rule: 'a' })).not.toBe(
            ruleContextNeedHash({ rule: 'b' }),
        );
    });

    // The point of the whole thing: bumping the constant must invalidate every
    // stored verdict, so one sweep re-asks the fleet and the installed base
    // actually receives a corrected classification.
    it('does NOT depend on examples, unlike ruleCompileHash', () => {
        // Examples gate whether a regex compiles; they do not change what a
        // rule needs to SEE. Including them would re-spend a model call every
        // time an author added a snippet.
        expect(
            ruleContextNeedHash({ rule: 'x', examples: [{ a: 1 }] } as any),
        ).toBe(ruleContextNeedHash({ rule: 'x' }));
    });

    it('treats an empty rule as a real, stable key', () => {
        expect(ruleContextNeedHash({})).toBe(ruleContextNeedHash({ rule: '' }));
    });
});

/**
 * The gate that decides whether a corrected classifier ever reaches an existing
 * rule. Getting this wrong is silent: the sweep skips the rule, reports it as
 * "already decided", and the fleet keeps the old verdict forever.
 */
describe('contextNeedIsCurrent', () => {
    const { contextNeedIsCurrent, ruleContextNeedHash } =
        require('./compile-hash') as typeof import('./compile-hash');

    const text = 'functions must not exceed 40 lines';

    it('is false for a rule that was never classified', () => {
        expect(contextNeedIsCurrent({ rule: text })).toBe(false);
    });

    it('is true when the stored hash matches this text and this version', () => {
        expect(
            contextNeedIsCurrent({
                rule: text,
                contextNeed: {
                    sourceHash: ruleContextNeedHash({ rule: text }),
                    source: 'compiler',
                },
            }),
        ).toBe(true);
    });

    // The whole reason the constant exists: a rule nobody edited, classified by
    // the OLD prompt, must come back as stale so one sweep re-asks it.
    it('is false for a verdict left by an earlier classifier version', () => {
        const asIfOldVersion = require('crypto')
            .createHash('sha256')
            .update(`v1 ${text}`)
            .digest('hex');

        expect(
            contextNeedIsCurrent({
                rule: text,
                contextNeed: { sourceHash: asIfOldVersion, source: 'compiler' },
            }),
        ).toBe(false);
    });

    it('is false once the rule text changes', () => {
        expect(
            contextNeedIsCurrent({
                rule: 'a different rule',
                contextNeed: {
                    sourceHash: ruleContextNeedHash({ rule: text }),
                    source: 'compiler',
                },
            }),
        ).toBe(false);
    });

    // An author outranks the classifier. A prompt version has no business
    // overriding a human's answer about their own rule.
    it('treats an author-set need as current whatever the hash says', () => {
        expect(
            contextNeedIsCurrent({
                rule: text,
                contextNeed: {
                    sourceHash: 'anything-at-all',
                    source: 'author',
                },
            }),
        ).toBe(true);
    });
});
