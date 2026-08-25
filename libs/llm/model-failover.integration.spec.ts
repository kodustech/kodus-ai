/**
 * model-failover.integration.spec.ts — `shouldFailoverToNextModel` against the
 * REAL error classifier (only the logger is mocked). `model-failover.spec.ts`
 * mocks the classifier to pin the loop logic; this pins the OTHER half — that a
 * real provider error actually classifies to the category that (does not) cascade,
 * so a regression in the status→category mapping is caught here, not silently.
 */
jest.mock('@libs/core/log/logger', () => ({
    createLogger: () => ({ warn: jest.fn() }),
}));

import { shouldFailoverToNextModel } from './model-failover';

const withStatus = (status: number, message = 'boom'): Error =>
    Object.assign(new Error(message), { status });

describe('shouldFailoverToNextModel — real classifier composition', () => {
    it.each([401, 403])('cascades on an auth failure (%i)', (status) => {
        expect(shouldFailoverToNextModel(withStatus(status, 'not authorized'))).toBe(
            true,
        );
    });

    it.each([500, 502, 503, 504])(
        'cascades on a persistent upstream error (%i)',
        (status) => {
            expect(
                shouldFailoverToNextModel(withStatus(status, 'upstream error')),
            ).toBe(true);
        },
    );

    it('does NOT cascade on a rate-limit (429) — the limiter owns backoff', () => {
        expect(shouldFailoverToNextModel(withStatus(429, 'rate limited'))).toBe(
            false,
        );
    });

    it('does NOT cascade on an abort / hard-timeout', () => {
        expect(
            shouldFailoverToNextModel(
                Object.assign(new Error('The operation was aborted'), {
                    name: 'AbortError',
                }),
            ),
        ).toBe(false);
        expect(
            shouldFailoverToNextModel(new Error('[HARD-TIMEOUT] exceeded budget')),
        ).toBe(false);
    });
});
