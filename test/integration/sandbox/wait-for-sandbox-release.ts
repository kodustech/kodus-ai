import { retryWithBackoff } from '@libs/common/utils/polling';

// The lease manager can return while its last sandbox command drains.
// Wait for the observable cleanup outcome before starting another scenario.
export function waitForSandboxRelease(assertReleased: () => Promise<void>) {
    return retryWithBackoff(assertReleased, {
        maxAttempts: 30,
        backoff: { baseInterval: 50, maxInterval: 250, jitterFactor: 0 },
    });
}
