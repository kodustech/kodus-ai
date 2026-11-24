import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import {
    hasOpenChangeRequestFinding,
    hasOpenFinding,
    hostCommentKey,
    isCriticalFinding,
} from './own-change-request';

const thread = (id: number | string, isResolved: boolean) => ({
    id,
    isResolved,
});

const open = (
    commentIds: string[],
    comments: Parameters<typeof hasOpenFinding>[1],
    platform = PlatformType.GITLAB,
) => hasOpenFinding(commentIds, comments, platform);

describe('hasOpenFinding', () => {
    it('is closed once every finding behind the request is resolved, whatever else is open', () => {
        expect(
            open(
                ['1', '2'],
                [thread(1, true), thread(2, true), thread(3, false)],
            ),
        ).toBe(false);
    });

    it('stays open while one of them is unresolved', () => {
        expect(open(['1', '2'], [thread(1, true), thread(2, false)])).toBe(
            true,
        );
    });

    it('counts a comment the host does not list as open', () => {
        expect(open(['1'], [])).toBe(true);
        expect(open(['1'], [thread(2, true)])).toBe(true);
    });

    it('stays open with no finding on record to check', () => {
        expect(open([], [thread(1, true)])).toBe(true);
    });

    it('reads a comment listed twice by its first entry, and skips one without an id', () => {
        expect(open(['1'], [thread(1, true), thread(1, false)])).toBe(false);
        expect(open(['1'], [thread(1, false), thread(1, true)])).toBe(true);
        expect(open(['1'], [{ isResolved: false }, thread(1, true)])).toBe(
            false,
        );
    });

    it('treats a thread without a resolved flag as open', () => {
        expect(open(['1'], [{ id: 1 }])).toBe(true);
    });

    it('resolves a GitHub thread by the database id of its comment', () => {
        expect(
            open(
                ['11'],
                [{ id: 'PRRT_x', fullDatabaseId: 11, isResolved: true }],
                PlatformType.GITHUB,
            ),
        ).toBe(false);
    });
});

describe('hostCommentKey', () => {
    it.each([
        [PlatformType.GITHUB, { id: 'node', fullDatabaseId: 11 }, '11'],
        [PlatformType.GITHUB, { id: 12 }, '12'],
        [PlatformType.AZURE_REPOS, { id: 1, threadId: 13 }, '13'],
        [PlatformType.AZURE_REPOS, { id: 1 }, undefined],
        [PlatformType.BITBUCKET, { id: 14, threadId: 99 }, '14'],
        [PlatformType.FORGEJO, { id: '' }, undefined],
        [PlatformType.GITLAB, { id: null }, undefined],
        [PlatformType.GITLAB, { id: 0 }, '0'],
    ])('reads the id each host matches on (%s)', (platform, comment, key) => {
        expect(hostCommentKey(comment, platform)).toBe(key);
    });
});

describe('isCriticalFinding', () => {
    it.each([
        ['critical', true],
        ['CRITICAL', true],
        ['high', false],
        [undefined, false],
    ])('%s -> %s', (severity, expected) => {
        expect(isCriticalFinding({ severity })).toBe(expected);
    });
});

describe('hasOpenChangeRequestFinding', () => {
    const github = PlatformType.GITHUB;
    const hostThread = (fullDatabaseId: number, isResolved: boolean) => ({
        fullDatabaseId,
        isResolved,
    });

    it('closes a finding the implementation check found implemented, with no comment id', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: [], suggestionIds: ['a'] },
                [{ suggestionId: 'a', implementationStatus: 'implemented' }],
                [],
                github,
            ),
        ).toBe(false);
    });

    it('closes a finding whose thread is resolved on the host, though not implemented', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: ['11'], suggestionIds: ['a'] },
                [
                    {
                        suggestionId: 'a',
                        commentId: '11',
                        implementationStatus: 'not_implemented',
                    },
                ],
                [hostThread(11, true)],
                github,
            ),
        ).toBe(false);
    });

    // Only A had a comment id; A is fixed, B is not. Judged by comments
    // alone the request would leave with B still open.
    it('keeps a finding open when it has no comment id and is not implemented', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: ['11'], suggestionIds: ['a', 'b'] },
                [
                    {
                        suggestionId: 'a',
                        commentId: '11',
                        implementationStatus: 'implemented',
                    },
                    {
                        suggestionId: 'b',
                        implementationStatus: 'not_implemented',
                    },
                ],
                [hostThread(11, true)],
                github,
            ),
        ).toBe(true);
    });

    it('keeps a partially implemented finding open', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: [], suggestionIds: ['a'] },
                [
                    {
                        suggestionId: 'a',
                        implementationStatus: 'partially_implemented',
                    },
                ],
                [],
                github,
            ),
        ).toBe(true);
    });

    it('keeps a suggestion the PR no longer stores open', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: [], suggestionIds: ['a'] },
                [],
                [],
                github,
            ),
        ).toBe(true);
    });

    it('judges a request recorded before its suggestions by its comments', () => {
        expect(
            hasOpenChangeRequestFinding(
                { commentIds: ['11'] },
                [],
                [hostThread(11, true)],
                github,
            ),
        ).toBe(false);
        expect(
            hasOpenChangeRequestFinding({ commentIds: [] }, [], [], github),
        ).toBe(true);
    });
});
