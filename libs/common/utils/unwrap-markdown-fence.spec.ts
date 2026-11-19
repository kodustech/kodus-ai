import { unwrapMarkdownFence } from './unwrap-markdown-fence';

describe('unwrapMarkdownFence', () => {
    it('returns the document inside a markdown fence', () => {
        expect(unwrapMarkdownFence('```markdown\n## Title\n\nBody\n```')).toBe(
            '## Title\n\nBody',
        );
    });

    it('keeps the code blocks of a document wrapped in a markdown fence', () => {
        const doc = '## Use it\n\n```ts\ndebounce(fn, 100);\n```';
        expect(unwrapMarkdownFence('```md\n' + doc + '\n```')).toBe(doc);
    });

    it('returns the document inside a fence that names no language', () => {
        expect(unwrapMarkdownFence('```\n## Title\n```')).toBe('## Title');
    });

    it('leaves a document that opens and closes with its own code blocks alone', () => {
        const doc = '```\nconst a = 1;\n```\n\nThen\n\n```\nconst b = 2;\n```';
        expect(unwrapMarkdownFence(doc)).toBe(doc);
    });

    it('leaves a single code block in another language alone', () => {
        const doc = '```ts\nconst a = 1;\n```';
        expect(unwrapMarkdownFence(doc)).toBe(doc);
    });

    it('returns an unfenced document trimmed', () => {
        expect(unwrapMarkdownFence('  ## Title\n')).toBe('## Title');
    });
});
