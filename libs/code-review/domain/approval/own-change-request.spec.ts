import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import {
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
            open(['1', '2'], [thread(1, true), thread(2, true), thread(3, false)]),
        ).toBe(false);
    });

    it('stays open while one of them is unresolved', () => {
        expect(open(['1', '2'], [thread(1, true), thread(2, false)])).toBe(true);
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
        expect(open(['1'], [{ isResolved: false }, thread(1, true)])).toBe(false);
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
