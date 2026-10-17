import { normalizeRepoPath, resolveInsideFolder } from './knowledge-path';

describe('normalizeRepoPath', () => {
    it('normalizes a plain repository path', () => {
        expect(normalizeRepoPath('docs/guide.md')).toBe('docs/guide.md');
        expect(normalizeRepoPath('./docs//guide.md')).toBe('docs/guide.md');
        expect(normalizeRepoPath('docs/./guide.md')).toBe('docs/guide.md');
        expect(normalizeRepoPath('.claude/skills/x/')).toBe('.claude/skills/x');
    });

    it.each([
        '',
        '/etc/passwd',
        '../outside.md',
        'docs/../../outside.md',
        'docs/../guide.md',
        'docs\\..\\guide.md',
        'docs/gu\0ide.md',
        'docs/gu\nide.md',
        '.',
        '.git/config',
        'C:/windows',
    ])('refuses %j', (input) => {
        expect(normalizeRepoPath(input)).toBeNull();
    });
});

describe('resolveInsideFolder', () => {
    const folder = '.claude/skills/invoice-errors';

    it('joins a reference inside the skill folder', () => {
        expect(resolveInsideFolder(folder, 'references/codes.md')).toBe(
            '.claude/skills/invoice-errors/references/codes.md',
        );
        expect(resolveInsideFolder(folder, 'NOTES.md')).toBe(
            '.claude/skills/invoice-errors/NOTES.md',
        );
    });

    it.each([
        '../other-skill/SKILL.md',
        'references/../../other-skill/SKILL.md',
        '/etc/passwd',
        'references/deep/nested/file.md',
        '',
    ])('refuses %j', (relative) => {
        expect(resolveInsideFolder(folder, relative)).toBeNull();
    });
});
