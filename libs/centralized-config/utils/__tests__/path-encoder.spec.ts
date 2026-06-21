import {
    GROUP_PATH_JOINER,
    InvalidGroupPathError,
    buildGroupFolderName,
    decodePathSegment,
    encodePathSegment,
    parseGroupFolderName,
    validateGroupPaths,
} from '../path-encoder';

describe('path-encoder', () => {
    describe('encodePathSegment', () => {
        it('encodes slash as %2F', () => {
            expect(encodePathSegment('app/models')).toBe('app%2Fmodels');
        });

        it('encodes percent as %25 before encoding slash', () => {
            expect(encodePathSegment('a%b')).toBe('a%25b');
            expect(encodePathSegment('a%/b')).toBe('a%25%2Fb');
        });

        it('strips leading and trailing slashes', () => {
            expect(encodePathSegment('/src/api/')).toBe('src%2Fapi');
        });

        it('trims surrounding whitespace', () => {
            expect(encodePathSegment('  src/api  ')).toBe('src%2Fapi');
        });

        it('rejects empty string', () => {
            expect(() => encodePathSegment('')).toThrow(InvalidGroupPathError);
        });

        it('rejects whitespace-only', () => {
            expect(() => encodePathSegment('   ')).toThrow(
                InvalidGroupPathError,
            );
        });

        it('rejects root', () => {
            expect(() => encodePathSegment('/')).toThrow(InvalidGroupPathError);
            expect(() => encodePathSegment('//')).toThrow(
                InvalidGroupPathError,
            );
        });

        it('rejects non-string input', () => {
            expect(() => encodePathSegment(null as unknown as string)).toThrow(
                InvalidGroupPathError,
            );
        });
    });

    describe('decodePathSegment', () => {
        it('decodes %2F as slash', () => {
            expect(decodePathSegment('app%2Fmodels')).toBe('app/models');
        });

        it('decodes %25 as percent', () => {
            expect(decodePathSegment('a%25b')).toBe('a%b');
        });

        it('does not re-interpret a decoded percent as the start of an escape', () => {
            expect(decodePathSegment('a%252F')).toBe('a%2F');
        });

        it('round-trips slashes and percents', () => {
            const cases = ['app/src', 'a%b', 'app%2Fsrc', 'weird&name', 'a%/b'];
            for (const input of cases) {
                expect(decodePathSegment(encodePathSegment(input))).toBe(
                    input.replace(/^\/+|\/+$/g, ''),
                );
            }
        });
    });

    describe('validateGroupPaths', () => {
        it('accepts a single valid path', () => {
            expect(() => validateGroupPaths(['src/api'])).not.toThrow();
        });

        it('accepts multiple distinct valid paths', () => {
            expect(() =>
                validateGroupPaths(['src/api', 'src/web']),
            ).not.toThrow();
        });

        it('rejects empty array', () => {
            expect(() => validateGroupPaths([])).toThrow(InvalidGroupPathError);
        });

        it('rejects empty path inside array', () => {
            expect(() => validateGroupPaths(['src/api', ''])).toThrow(
                InvalidGroupPathError,
            );
        });

        it('rejects whitespace-only path', () => {
            expect(() => validateGroupPaths(['   '])).toThrow(
                InvalidGroupPathError,
            );
        });

        it('rejects root path', () => {
            expect(() => validateGroupPaths(['/'])).toThrow(
                InvalidGroupPathError,
            );
        });

        it('rejects duplicate paths after normalization', () => {
            expect(() =>
                validateGroupPaths(['src/api', '/src/api/']),
            ).toThrow(InvalidGroupPathError);
        });

        it('rejects non-string entries', () => {
            expect(() =>
                validateGroupPaths(['src/api', 42 as unknown as string]),
            ).toThrow(InvalidGroupPathError);
        });
    });

    describe('buildGroupFolderName', () => {
        it('encodes a single path with no joiner', () => {
            expect(buildGroupFolderName(['app/models'])).toBe('app%2Fmodels');
        });

        it('sorts paths case-sensitively before encoding', () => {
            const built = buildGroupFolderName([
                'app/services',
                'app/docs',
                'app/models',
            ]);
            expect(built).toBe(
                ['app%2Fdocs', 'app%2Fmodels', 'app%2Fservices'].join(
                    GROUP_PATH_JOINER,
                ),
            );
        });

        it('is invariant to input order', () => {
            expect(buildGroupFolderName(['b', 'a'])).toBe(
                buildGroupFolderName(['a', 'b']),
            );
        });

        it('uses & as the joiner', () => {
            expect(buildGroupFolderName(['a', 'b'])).toBe(`a${GROUP_PATH_JOINER}b`);
        });

        it('normalizes leading/trailing slashes before sorting', () => {
            expect(buildGroupFolderName(['/src/api/', '/src/web'])).toBe(
                'src%2Fapi&src%2Fweb',
            );
        });

        it('rejects invalid input via validateGroupPaths', () => {
            expect(() => buildGroupFolderName([])).toThrow(
                InvalidGroupPathError,
            );
            expect(() => buildGroupFolderName(['/'])).toThrow(
                InvalidGroupPathError,
            );
            expect(() => buildGroupFolderName(['a', 'a'])).toThrow(
                InvalidGroupPathError,
            );
        });
    });

    describe('parseGroupFolderName', () => {
        it('decodes a single-path folder name', () => {
            expect(parseGroupFolderName('app%2Fmodels')).toEqual([
                'app/models',
            ]);
        });

        it('decodes and sorts a multi-path folder name', () => {
            expect(
                parseGroupFolderName('app%2Fservices&app%2Fdocs&app%2Fmodels'),
            ).toEqual(['app/docs', 'app/models', 'app/services']);
        });

        it('round-trips with buildGroupFolderName', () => {
            const original = ['app/docs', 'app/models', 'app/services'];
            const folder = buildGroupFolderName(original);
            expect(parseGroupFolderName(folder)).toEqual(original);
        });

        it('returns null for an empty string', () => {
            expect(parseGroupFolderName('')).toBeNull();
        });

        it('returns null for non-string input', () => {
            expect(
                parseGroupFolderName(undefined as unknown as string),
            ).toBeNull();
            expect(parseGroupFolderName(null as unknown as string)).toBeNull();
        });

        it('returns null when any segment decodes to an invalid path', () => {
            expect(parseGroupFolderName('app%2Fmodels&')).toBeNull();
            expect(parseGroupFolderName('&app%2Fmodels')).toBeNull();
        });

        it('returns null on duplicate paths', () => {
            expect(parseGroupFolderName('app%2Fmodels&app%2Fmodels')).toBeNull();
        });
    });
});
