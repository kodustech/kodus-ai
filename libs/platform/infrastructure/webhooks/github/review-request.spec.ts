import { requestedReviewerOf } from './review-request';

const kody = { login: 'kody-ai[bot]', node_id: 'BOT_kody', type: 'Bot' };
const payload = (over: Record<string, unknown> = {}) => ({
    action: 'review_requested',
    requested_reviewer: kody,
    ...over,
});

describe('requestedReviewerOf', () => {
    it('answers the account a review was requested from', () => {
        expect(requestedReviewerOf('pull_request', payload())).toBe(kody);
    });

    // The App's deliveries carry `installation`, and there Kody is the bot.
    it('answers the bot a delivery of the App names', () => {
        expect(
            requestedReviewerOf(
                'pull_request',
                payload({ installation: { id: 1 } }),
            ),
        ).toBe(kody);
    });

    it('answers nothing for a person a delivery of the App names', () => {
        const person = { login: 'dev', node_id: 'U_dev', type: 'User' };
        expect(
            requestedReviewerOf(
                'pull_request',
                payload({
                    installation: { id: 1 },
                    requested_reviewer: person,
                }),
            ),
        ).toBeNull();
    });

    // A repository webhook: Kody may be acting as that person's token.
    it('answers a person a delivery without an installation names', () => {
        const person = { login: 'dev', node_id: 'U_dev', type: 'User' };
        expect(
            requestedReviewerOf(
                'pull_request',
                payload({ requested_reviewer: person }),
            ),
        ).toBe(person);
    });

    it.each([
        ['another event', 'pull_request_review', payload()],
        [
            'another action',
            'pull_request',
            payload({ action: 'review_request_removed' }),
        ],
        [
            'a request made to a team',
            'pull_request',
            payload({
                requested_reviewer: undefined,
                requested_team: { slug: 'backend' },
            }),
        ],
        [
            'an account without a node id',
            'pull_request',
            payload({ requested_reviewer: { login: 'kody-ai[bot]' } }),
        ],
        [
            'an account without a login',
            'pull_request',
            payload({ requested_reviewer: { node_id: 'BOT_kody' } }),
        ],
        ['no payload', 'pull_request', undefined],
    ])('answers nothing for %s', (_name, event, body) => {
        expect(requestedReviewerOf(event, body)).toBeNull();
    });
});
