import {
    authorMatchesExact,
    isOpenPullRequest,
    isUnresolvedDeliveredSuggestion,
    matchesPullRequestState,
} from './pull-request-metrics';

describe('isOpenPullRequest', () => {
    it('is open when not merged and status is open', () => {
        expect(isOpenPullRequest({ merged: false, status: 'open' })).toBe(true);
    });

    it('is NOT open when merged', () => {
        expect(isOpenPullRequest({ merged: true, status: 'merged' })).toBe(
            false,
        );
    });

    it('is NOT open when status is closed (any casing)', () => {
        expect(isOpenPullRequest({ merged: false, status: 'closed' })).toBe(
            false,
        );
        expect(isOpenPullRequest({ merged: false, status: 'CLOSED' })).toBe(
            false,
        );
        expect(isOpenPullRequest({ merged: false, status: 'Closed' })).toBe(
            false,
        );
    });

    it('treats missing/undefined status as open (not closed)', () => {
        expect(isOpenPullRequest({ merged: false })).toBe(true);
        expect(isOpenPullRequest({})).toBe(true);
    });

    it('is NOT open when merged even if status is not closed', () => {
        expect(isOpenPullRequest({ merged: true, status: 'open' })).toBe(false);
    });
});

describe('isUnresolvedDeliveredSuggestion', () => {
    it('is unresolved when sent and not implemented', () => {
        expect(
            isUnresolvedDeliveredSuggestion({
                deliveryStatus: 'sent',
                implementationStatus: 'not_implemented',
            }),
        ).toBe(true);
    });

    it('is unresolved when sent and partially implemented', () => {
        expect(
            isUnresolvedDeliveredSuggestion({
                deliveryStatus: 'sent',
                implementationStatus: 'partially_implemented',
            }),
        ).toBe(true);
    });

    it('is unresolved when sent with a missing implementation status', () => {
        expect(
            isUnresolvedDeliveredSuggestion({ deliveryStatus: 'sent' }),
        ).toBe(true);
    });

    it('is resolved when implemented', () => {
        expect(
            isUnresolvedDeliveredSuggestion({
                deliveryStatus: 'sent',
                implementationStatus: 'implemented',
            }),
        ).toBe(false);
    });

    it('does not count non-sent suggestions (filtered/failed)', () => {
        expect(
            isUnresolvedDeliveredSuggestion({
                deliveryStatus: 'not_sent',
                implementationStatus: 'not_implemented',
            }),
        ).toBe(false);
        expect(
            isUnresolvedDeliveredSuggestion({
                deliveryStatus: 'failed',
                implementationStatus: 'not_implemented',
            }),
        ).toBe(false);
    });
});

describe('authorMatchesExact', () => {
    const author = {
        name: 'Wellington Santana',
        username: 'Wellington01',
        email: 'well@acme.dev',
    };

    it('matches the exact display name (case-insensitive)', () => {
        expect(authorMatchesExact(author, 'Wellington Santana')).toBe(true);
        expect(authorMatchesExact(author, 'wellington santana')).toBe(true);
    });

    it('matches by exact username or email too', () => {
        expect(authorMatchesExact(author, 'Wellington01')).toBe(true);
        expect(authorMatchesExact(author, 'WELL@ACME.DEV')).toBe(true);
    });

    it('does NOT match a different name that merely contains it', () => {
        expect(
            authorMatchesExact(
                { name: 'Wellington Cristi Vilela Santana' },
                'Wellington Santana',
            ),
        ).toBe(false);
    });

    it('does NOT match a partial/substring of the name', () => {
        expect(authorMatchesExact(author, 'Wellington')).toBe(false);
        expect(authorMatchesExact(author, 'Santana')).toBe(false);
    });

    it('matches everything when the target is empty', () => {
        expect(authorMatchesExact(author, '')).toBe(true);
        expect(authorMatchesExact(author, '   ')).toBe(true);
    });

    it('handles a missing user without throwing', () => {
        expect(authorMatchesExact(null, 'anyone')).toBe(false);
        expect(authorMatchesExact({}, 'anyone')).toBe(false);
    });
});


describe('matchesPullRequestState', () => {
    const open = { merged: false, status: 'open' };
    const merged = { merged: true, status: 'open' };
    const closed = { merged: false, status: 'closed' };

    it('matches everything when no state is asked for', () => {
        expect(matchesPullRequestState(open, undefined)).toBe(true);
        expect(matchesPullRequestState(closed, undefined)).toBe(true);
        expect(matchesPullRequestState(merged, undefined)).toBe(true);
    });

    it('keeps only open PRs under "open"', () => {
        expect(matchesPullRequestState(open, 'open')).toBe(true);
        expect(matchesPullRequestState(closed, 'open')).toBe(false);
        expect(matchesPullRequestState(merged, 'open')).toBe(false);
    });

    it('keeps merged and closed PRs under "closed"', () => {
        expect(matchesPullRequestState(closed, 'closed')).toBe(true);
        expect(matchesPullRequestState(merged, 'closed')).toBe(true);
        expect(matchesPullRequestState(open, 'closed')).toBe(false);
    });

    // The two filters sit side by side on the screen and are constantly
    // confused; the state filter must key off the PR only, never off how
    // Kody's run went.
    it('never partitions on anything but merged/status', () => {
        expect(
            matchesPullRequestState(
                { ...open, ...({ executionStatus: 'error' } as object) },
                'open',
            ),
        ).toBe(true);
    });

    // A record whose close event we never received still reads open. The
    // filter must not paper over that — it reports what we stored, and the
    // list's most-recent-execution ordering is what keeps those at the bottom.
    it('treats a record with no close data as open, as stored', () => {
        expect(matchesPullRequestState({ status: 'open' }, 'open')).toBe(true);
    });
});
