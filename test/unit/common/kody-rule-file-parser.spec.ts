import {
    extractExamplesFromBody,
    isKodyRuleTemplateFile,
    parseKodyRuleFile,
} from '../../../libs/common/utils/kody-rules/kody-rule-file-parser';

// Mirrors the real-world template from the "Repository Rules" docs page —
// the exact shape a customer authored when they hit the lossy LLM import
// (#1487): trimmed examples, rewritten wording, stripped identifiers.
const TEMPLATE = `---
title: "No exceptions for control flow"
scope: "file"
path: ["app/**/*.rb", "lib/**/*.rb"]
severity_min: "medium"
languages: ["ruby"]
buckets: ["error-handling"]
enabled: true
---

## Instructions
- **CF1** No exceptions for control flow — anywhere in the codebase.
- **CF2** \`raise\` is reserved for genuinely unexpected conditions.

## Examples

### Bad example
\`\`\`ruby
def publish(post)
  raise NotReady unless post.ready?
end
\`\`\`

### Good example
\`\`\`ruby
def publish(post)
  return false unless post.ready?
  true
end
\`\`\`
`;

describe('parseKodyRuleFile', () => {
    it('parses the documented template verbatim', () => {
        const parsed = parseKodyRuleFile(TEMPLATE);

        expect(parsed).not.toBeNull();
        expect(parsed!.title).toBe('No exceptions for control flow');
        expect(parsed!.scope).toBe('file');
        expect(parsed!.severity).toBe('medium');
        expect(parsed!.enabled).toBe(true);
        // Multi-glob frontmatter arrays become the comma-joined storage
        // form the review matchers consume.
        expect(parsed!.path).toBe('app/**/*.rb,lib/**/*.rb');
        // Body is verbatim — identifiers like **CF1** must survive.
        expect(parsed!.rule).toContain('**CF1**');
        expect(parsed!.rule).toContain('**CF2**');
        expect(parsed!.rule).toContain('## Instructions');
    });

    it('extracts Bad/Good examples structurally', () => {
        const parsed = parseKodyRuleFile(TEMPLATE)!;

        expect(parsed.examples).toHaveLength(2);
        expect(parsed.examples[0]).toEqual({
            snippet: expect.stringContaining('raise NotReady'),
            isCorrect: false,
        });
        expect(parsed.examples[1]).toEqual({
            snippet: expect.stringContaining('return false'),
            isCorrect: true,
        });
    });

    it('accepts a plain-string path and `severity` as an alias', () => {
        const parsed = parseKodyRuleFile(
            [
                '---',
                'title: T',
                'path: "src/**"',
                'severity: HIGH',
                '---',
                'Body.',
            ].join('\n'),
        )!;
        expect(parsed.path).toBe('src/**');
        expect(parsed.severity).toBe('high');
    });

    it('defaults: severity medium, scope file, path repo-wide', () => {
        const parsed = parseKodyRuleFile(
            ['---', 'title: T', '---', 'Body.'].join('\n'),
        )!;
        expect(parsed.severity).toBe('medium');
        expect(parsed.scope).toBe('file');
        expect(parsed.path).toBe('**/*');
    });

    it('reports enabled=false so callers can skip the import', () => {
        const parsed = parseKodyRuleFile(
            ['---', 'title: T', 'enabled: false', '---', 'Body.'].join('\n'),
        )!;
        expect(parsed.enabled).toBe(false);
    });

    it('passes uuid through when declared', () => {
        const parsed = parseKodyRuleFile(
            [
                '---',
                'title: T',
                'uuid: 2f9d8c1e-1111-2222-3333-444455556666',
                '---',
                'Body.',
            ].join('\n'),
        )!;
        expect(parsed.uuid).toBe('2f9d8c1e-1111-2222-3333-444455556666');
    });

    it.each([
        ['no frontmatter', '# Just markdown\nSome rule text.'],
        ['invalid yaml', '---\ntitle: [unclosed\n---\nBody.'],
        ['missing title', '---\nscope: file\n---\nBody.'],
        ['empty body', '---\ntitle: T\n---\n'],
        ['empty content', ''],
    ])('returns null for %s (caller falls back to LLM)', (_name, content) => {
        expect(parseKodyRuleFile(content)).toBeNull();
    });
});

describe('extractExamplesFromBody', () => {
    it('captures multiple fenced blocks under one heading', () => {
        const body = [
            '### Bad example',
            '```js',
            'a()',
            '```',
            'prose in between',
            '```js',
            'b()',
            '```',
            '### Good example',
            '```js',
            'c()',
            '```',
        ].join('\n');

        expect(extractExamplesFromBody(body)).toEqual([
            { snippet: 'a()', isCorrect: false },
            { snippet: 'b()', isCorrect: false },
            { snippet: 'c()', isCorrect: true },
        ]);
    });

    it('keeps capturing across deeper subheadings inside a section', () => {
        // An H4 under an H3 "Bad example" must not close the section;
        // only a heading at the same-or-higher level does.
        const body = [
            '### Bad example',
            '#### Details',
            '```js',
            'a()',
            '```',
            '### Notes',
            '```js',
            'outside()',
            '```',
        ].join('\n');

        expect(extractExamplesFromBody(body)).toEqual([
            { snippet: 'a()', isCorrect: false },
        ]);
    });

    it('ignores fences outside bad/good sections', () => {
        const body = [
            '## Instructions',
            '```js',
            'setup()',
            '```',
            '### Good example',
            '```js',
            'ok()',
            '```',
        ].join('\n');

        expect(extractExamplesFromBody(body)).toEqual([
            { snippet: 'ok()', isCorrect: true },
        ]);
    });
});

describe('isKodyRuleTemplateFile', () => {
    it.each([
        ['.kody/rules/security.md', true],
        ['.kody/rules/architecture/layering.md', true],
        ['apps/api/.kody/rules/naming.md', true],
        ['rules/architecture/layering.md', true],
        ['apps/api/rules/naming.md', true],
        ['rules/naming.txt', false],
        ['rules/.md', true],
        ['xrules/foo.md', false],
        ['foo/.rules/bar.md', false],
        ['.kody/other/file.md', false],
        ['CLAUDE.md', false],
        ['docs/coding-standards/style.md', false],
        [null, false],
    ])('%s → %s', (filePath, expected) => {
        expect(isKodyRuleTemplateFile(filePath as any)).toBe(expected);
    });
});
