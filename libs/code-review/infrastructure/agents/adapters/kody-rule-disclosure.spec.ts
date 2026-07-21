import {
    formatRulesIndex,
    resolveRule,
    makeGetKodyRuleTool,
    INLINE_RULE_MAX_CHARS,
} from '@libs/code-review/infrastructure/agents/adapters/kody-rule-disclosure';

const short = { title: 'No console.log', rule: 'Do not leave console.log in production code.' };
const long = {
    title: 'Error handling',
    rule: 'x'.repeat(INLINE_RULE_MAX_CHARS + 50),
};

describe('formatRulesIndex', () => {
    it('returns empty string for no rules', () => {
        expect(formatRulesIndex(undefined)).toBe('');
        expect(formatRulesIndex([])).toBe('');
    });

    it('renders a short rule inline in full', () => {
        const out = formatRulesIndex([short]);
        expect(out).toContain('**No console.log**');
        expect(out).toContain('Do not leave console.log in production code.');
        expect(out).not.toContain('getKodyRule to read');
    });

    it('defers a long rule to a teaser + getKodyRule hint', () => {
        const out = formatRulesIndex([long]);
        expect(out).toContain('**Error handling**');
        expect(out).toContain('call getKodyRule to read the full rule');
        // the full body is NOT dumped
        expect(out).not.toContain('x'.repeat(INLINE_RULE_MAX_CHARS + 50));
    });

    it('numbers rules with a [n] index', () => {
        const out = formatRulesIndex([short, long]);
        expect(out).toContain('[1] **No console.log**');
        expect(out).toContain('[2] **Error handling**');
    });
});

describe('resolveRule', () => {
    const rules = [short, long];

    it('resolves by [n] index and bare number', () => {
        expect(resolveRule(rules, '[2]')).toBe(long);
        expect(resolveRule(rules, '1')).toBe(short);
    });

    it('resolves by exact title (case-insensitive)', () => {
        expect(resolveRule(rules, 'error handling')).toBe(long);
    });

    it('resolves by title substring', () => {
        expect(resolveRule(rules, 'console')).toBe(short);
    });

    it('returns undefined for out-of-range index and no match', () => {
        expect(resolveRule(rules, '99')).toBeUndefined();
        expect(resolveRule(rules, 'nonexistent xyz')).toBeUndefined();
    });
});

describe('makeGetKodyRuleTool', () => {
    it('returns the full body of a matched rule', async () => {
        const tool = makeGetKodyRuleTool([short, long]);
        const res = await tool.execute({ query: 'Error handling' }, {} as any);
        expect(res.output).toContain('**Error handling**');
        expect(res.output).toContain('x'.repeat(INLINE_RULE_MAX_CHARS + 50));
        expect(res.isError).toBeFalsy();
    });

    it('lists available titles and flags error when nothing matches', async () => {
        const tool = makeGetKodyRuleTool([short, long]);
        const res = await tool.execute({ query: 'zzz' }, {} as any);
        expect(res.isError).toBe(true);
        expect(res.output).toContain('No rule matched');
        expect(res.output).toContain('No console.log');
        expect(res.output).toContain('Error handling');
    });

    it('never throws on a malformed input', async () => {
        const tool = makeGetKodyRuleTool([short]);
        const res = await tool.execute({}, {} as any);
        expect(res.isError).toBe(true);
    });
});
