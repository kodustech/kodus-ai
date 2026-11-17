import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { PR_DESCRIPTION_LIMITS, fitPRDescription } from './fit-pr-description';

const END_MARKER = '<!-- kody-pr-summary:end -->';
const NOTICE_FRAGMENT = '(truncated by Kody';

// The truncation logic is the same for every platform; Azure (4 000) is the
// only limit tight enough to be hit in production (#1045).
const LIMIT = 4_000;
const PLATFORM = PlatformType.AZURE_REPOS;

describe('fitPRDescription', () => {
    it('returns the input unchanged when its length equals the limit', () => {
        const input = 'a'.repeat(LIMIT);
        expect(fitPRDescription(input, PLATFORM)).toBe(input);
    });

    it('truncates one character over the limit and appends the notice', () => {
        const input = 'b'.repeat(LIMIT + 1);
        const out = fitPRDescription(input, PLATFORM);
        expect(out.length).toBeLessThanOrEqual(LIMIT);
        expect(out.startsWith('b')).toBe(true);
        expect(out.endsWith('\n')).toBe(true); // notice ends in newline
        expect(out).toContain(NOTICE_FRAGMENT);
    });

    it('keeps the kody-pr-summary end marker last, with the notice right before it', () => {
        const input = 'X'.repeat(5_000) + END_MARKER;
        const out = fitPRDescription(input, PLATFORM);
        expect(out.length).toBeLessThanOrEqual(LIMIT);
        expect(out.endsWith(END_MARKER)).toBe(true);
        const noticeIdx = out.indexOf(NOTICE_FRAGMENT);
        expect(noticeIdx).toBeGreaterThan(0);
        expect(noticeIdx).toBeLessThan(out.lastIndexOf(END_MARKER));
    });

    it('returns the input unchanged for a platform without a registered limit', () => {
        const input = 'z'.repeat(2_000_000);
        // AZURE_BOARDS is in PlatformType but not in PR_DESCRIPTION_LIMITS.
        expect(fitPRDescription(input, PlatformType.AZURE_BOARDS)).toBe(input);
    });
});

describe('PR_DESCRIPTION_LIMITS map', () => {
    // A platform missing here is never truncated, and its API rejects the
    // oversized description instead.
    it('contains entries for every code-management platform we ship support for', () => {
        const codeManagementPlatforms = [
            PlatformType.AZURE_REPOS,
            PlatformType.BITBUCKET,
            PlatformType.GITHUB,
            PlatformType.GITLAB,
            PlatformType.FORGEJO,
        ];
        for (const platform of codeManagementPlatforms) {
            expect(PR_DESCRIPTION_LIMITS[platform]).toBeGreaterThan(0);
        }
    });
});
