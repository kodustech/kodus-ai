import { hasParentDirSegment } from './path-segments';

/**
 * A path climbs out of its root only through a segment that is exactly "..",
 * split on "/" and "\". A ".." inside a segment is part of a file name, as in
 * Next.js catch-all (`[...slug]`) and intercepting (`(..)photo`) routes, and
 * must not be read as traversal.
 */
describe('hasParentDirSegment', () => {
    it.each([
        'app/[...slug]/page.tsx',
        'app/[[...slug]]/page.tsx',
        'app/(..)photo/page.tsx',
        'app/(..)(..)photo/page.tsx',
        'app/(...)photo/page.tsx',
        'src/foo..bar.ts',
        'notes..',
        '..hidden/file.ts',
        'src/./a.ts',
        '.',
        '',
    ])('treats %p as a path that stays inside its root', (path) => {
        expect(hasParentDirSegment(path)).toBe(false);
    });

    it.each([
        '..',
        '../x',
        './../x',
        'a/../../x',
        'a/b/..',
        '/repo/../../etc/passwd',
        '..\\x',
        'a\\..\\..\\x',
        'C:\\repo\\..\\x',
        'a/..\\x',
        'app/[...slug]/../../secret',
        'a//../x',
        // A win32 host trims trailing spaces and dots from a segment.
        '.. /x',
        'sub/.. /.. /secret',
        'a/.. .\\x',
        '.../x',
    ])('treats %p as traversal', (path) => {
        expect(hasParentDirSegment(path)).toBe(true);
    });
});
