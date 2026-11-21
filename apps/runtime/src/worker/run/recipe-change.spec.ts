import { memberNotBootedOf } from './recipe-change';

/** A Run of a member repository's PR whose environment recipe is `content`. */
const req = (alias: string, content: string) =>
    ({
        workspace: [{ source: 'pull_request', role: 'member', alias }],
        environment: { recipe: { path: '.kodus/workspace.yaml', content } },
    }) as unknown as Parameters<typeof memberNotBootedOf>[0];

describe('memberNotBootedOf', () => {
    it('is undefined when the recipe builds ../<alias>', () => {
        expect(memberNotBootedOf(req('billing', 'services:\n  billing:\n    build: ../billing\n'))).toBeUndefined();
    });

    it('names the member when the recipe never mentions it', () => {
        expect(memberNotBootedOf(req('billing', 'services:\n  app:\n    build: .\n'))).toBe('billing');
    });

    it('reads every character of the alias literally, not as a pattern', () => {
        // `.` must not match any character, and `+` / `(` must neither throw nor repeat.
        expect(memberNotBootedOf(req('a.b', 'services:\n  x:\n    build: ../axb\n'))).toBe('a.b');
        expect(memberNotBootedOf(req('c++(lib)', 'services:\n  x:\n    build: ../c++(lib)\n'))).toBeUndefined();
        expect(memberNotBootedOf(req('c++(lib)', 'services:\n  x:\n    build: ../cc(lib)\n'))).toBe('c++(lib)');
    });
});
