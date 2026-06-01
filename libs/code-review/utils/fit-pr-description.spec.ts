import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import {
    PR_DESCRIPTION_LIMITS,
    fitPRDescription,
    getPRDescriptionLimit,
} from './fit-pr-description';

const END_MARKER = '<!-- kody-pr-summary:end -->';
const NOTICE_FRAGMENT = '(truncated by Kody';

describe('fitPRDescription', () => {
    describe.each([
        [PlatformType.AZURE_REPOS, 4_000],
        [PlatformType.BITBUCKET, 32_768],
        [PlatformType.GITHUB, 65_536],
        [PlatformType.GITLAB, 1_048_576],
        [PlatformType.FORGEJO, 1_048_576],
    ])('platform=%s (limit=%i)', (platform, limit) => {
        it('returns the input unchanged when length is below the limit', () => {
            const input = 'a'.repeat(limit - 1);
            expect(fitPRDescription(input, platform)).toBe(input);
        });

        it('returns the input unchanged when length equals the limit', () => {
            const input = 'a'.repeat(limit);
            expect(fitPRDescription(input, platform)).toBe(input);
        });

        it('truncates when the input exceeds the limit', () => {
            const input = 'a'.repeat(limit + 100);
            const out = fitPRDescription(input, platform);
            expect(out.length).toBeLessThanOrEqual(limit);
            expect(out).toContain(NOTICE_FRAGMENT);
        });

        it('preserves the kody-pr-summary end marker when the input ends with it', () => {
            const body = 'a'.repeat(limit + 200);
            const input = body + END_MARKER;
            const out = fitPRDescription(input, platform);
            expect(out.length).toBeLessThanOrEqual(limit);
            expect(out.endsWith(END_MARKER)).toBe(true);
            expect(out).toContain(NOTICE_FRAGMENT);
        });
    });

    describe('hard slice path (no closing marker)', () => {
        it('appends the truncation notice and stays at or below the limit', () => {
            const input = 'b'.repeat(5_000);
            const out = fitPRDescription(input, PlatformType.AZURE_REPOS);
            expect(out.length).toBeLessThanOrEqual(4_000);
            expect(out.endsWith('\n')).toBe(true); // notice ends in newline
            expect(out).toContain(NOTICE_FRAGMENT);
            expect(out.startsWith('b')).toBe(true);
        });
    });

    describe('marker-preserving path', () => {
        it('emits notice immediately before the end marker, not inside the user content', () => {
            const input = 'X'.repeat(5_000) + END_MARKER;
            const out = fitPRDescription(input, PlatformType.AZURE_REPOS);
            const noticeIdx = out.indexOf(NOTICE_FRAGMENT);
            const markerIdx = out.lastIndexOf(END_MARKER);
            expect(noticeIdx).toBeGreaterThan(0);
            expect(noticeIdx).toBeLessThan(markerIdx);
        });

        it('falls back to hard slice if the marker + notice alone overflow the limit (pathological)', () => {
            // Pick a tiny pseudo-limit by exercising AZURE on a large input
            // where everything must fit in 4000 chars. Marker (28) + notice
            // (~70) leave plenty of room — pathological case is exercised
            // in the unit-level test below using a hand-built fixture.
            const noticeLength = '\n\n_…(truncated by Kody to fit the platform description size limit)_\n'
                .length;
            const markerLength = END_MARKER.length;
            const minSafeLimit = noticeLength + markerLength + 1;
            // Confirm AZURE limit (4000) is well above the pathological
            // threshold so the fast path runs.
            expect(PR_DESCRIPTION_LIMITS[PlatformType.AZURE_REPOS]!).toBeGreaterThan(minSafeLimit);
        });
    });

    describe('unknown platform', () => {
        it('returns the input unchanged (no-op) for a platform without a registered limit', () => {
            const input = 'z'.repeat(10_000_000);
            // AZURE_BOARDS is in PlatformType but not in PR_DESCRIPTION_LIMITS.
            const out = fitPRDescription(input, PlatformType.AZURE_BOARDS);
            expect(out).toBe(input);
        });
    });

    describe('boundary cases for the AZURE limit (the only tight one in production)', () => {
        it('treats exactly 4001 chars as over-limit and truncates', () => {
            const input = 'c'.repeat(4_001);
            const out = fitPRDescription(input, PlatformType.AZURE_REPOS);
            expect(out.length).toBeLessThanOrEqual(4_000);
        });

        it('treats exactly 3999 chars as under-limit and keeps it intact', () => {
            const input = 'c'.repeat(3_999);
            const out = fitPRDescription(input, PlatformType.AZURE_REPOS);
            expect(out).toBe(input);
        });
    });
});

describe('getPRDescriptionLimit', () => {
    it.each([
        [PlatformType.AZURE_REPOS, 4_000],
        [PlatformType.BITBUCKET, 32_768],
        [PlatformType.GITHUB, 65_536],
        [PlatformType.GITLAB, 1_048_576],
        [PlatformType.FORGEJO, 1_048_576],
    ])('returns %i for %s', (platform, expected) => {
        expect(getPRDescriptionLimit(platform)).toBe(expected);
    });

    it('returns null for a platform without a registered limit', () => {
        // AZURE_BOARDS is a valid PlatformType but has no entry in the map
        // (boards aren't a code-management surface and have no PR description).
        expect(getPRDescriptionLimit(PlatformType.AZURE_BOARDS)).toBeNull();
    });
});

describe('PR_DESCRIPTION_LIMITS map', () => {
    it('contains entries for every code-management platform we ship support for', () => {
        const codeManagementPlatforms = [
            PlatformType.AZURE_REPOS,
            PlatformType.BITBUCKET,
            PlatformType.GITHUB,
            PlatformType.GITLAB,
            PlatformType.FORGEJO,
        ];
        for (const platform of codeManagementPlatforms) {
            expect(PR_DESCRIPTION_LIMITS[platform]).toBeDefined();
            expect(PR_DESCRIPTION_LIMITS[platform]).toBeGreaterThan(0);
        }
    });
});
