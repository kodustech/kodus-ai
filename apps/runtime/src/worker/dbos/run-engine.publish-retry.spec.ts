import { isPublishStep, PUBLISH_STEP_RETRY } from './run-engine.service';

describe('publish steps retry through a broker restart', () => {
    it('retries the steps that hand the product a publication, and only those', () => {
        expect(['publish', 'publish:awaiting_approval', 'publish:progress:testing'].every(isPublishStep)).toBe(true);
        expect(['agent:plan', 'verdict', 'publisher', 'state:errored'].some(isPublishStep)).toBe(false);
    });

    it('keeps trying for about ten minutes', () => {
        const { intervalSeconds, backoffRate, maxAttempts } = PUBLISH_STEP_RETRY;
        const waits = Array.from({ length: maxAttempts - 1 }, (_, i) => intervalSeconds * backoffRate ** i);
        const total = waits.reduce((a, b) => a + b, 0);
        expect(total).toBeGreaterThanOrEqual(600);
        expect(total).toBeLessThan(1_200);
    });
});
