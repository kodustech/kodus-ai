
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
    const { ruleContextNeedHash, CONTEXT_NEED_PROMPT_VERSION } =
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
    it('changes when the classifier version changes, for identical text', () => {
        const text = 'functions must not exceed 40 lines';
        const current = ruleContextNeedHash({ rule: text });

        const createHash = require('crypto').createHash;
        const asIfNextVersion = createHash('sha256')
            .update(`v${CONTEXT_NEED_PROMPT_VERSION + 1} ${text}`)
            .digest('hex');

        expect(asIfNextVersion).not.toBe(current);
    });

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
    const {
        contextNeedIsCurrent,
        ruleContextNeedHash,
    } = require('./compile-hash') as typeof import('./compile-hash');

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
                contextNeed: { sourceHash: 'anything-at-all', source: 'author' },
            }),
        ).toBe(true);
    });
});
