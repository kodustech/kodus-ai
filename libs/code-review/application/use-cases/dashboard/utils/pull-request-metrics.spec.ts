import {
    authorMatchesExact,
    isOpenPullRequest,
    isUnresolvedDeliveredSuggestion,
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
