import { decideSpendAlerts } from './spend-alert-decision';

describe('decideSpendAlerts', () => {
    it('does nothing when no threshold is crossed', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [], isOverLimit: false },
            {},
        );
        expect(decision).toEqual({
            thresholdsToAlert: [],
            sendFinalNotice: false,
            nextThresholdsSent: [],
            nextFinalNoticeSent: false,
            changed: false,
        });
    });

    it('alerts a newly crossed threshold once', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50], isOverLimit: false },
            {},
        );
        expect(decision.thresholdsToAlert).toEqual([50]);
        expect(decision.nextThresholdsSent).toEqual([50]);
        expect(decision.changed).toBe(true);
    });

    it('only alerts thresholds not already sent this period', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50, 75], isOverLimit: false },
            { thresholdsSent: [50] },
        );
        expect(decision.thresholdsToAlert).toEqual([75]);
        expect(decision.nextThresholdsSent).toEqual([50, 75]);
    });

    it('does not send the final notice on the same tick that 100% is first crossed', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50, 75, 90, 100], isOverLimit: true },
            {},
        );
        expect(decision.thresholdsToAlert).toEqual([50, 75, 90, 100]);
        // 100% was not previously sent → final notice waits for the next tick.
        expect(decision.sendFinalNotice).toBe(false);
        expect(decision.nextFinalNoticeSent).toBe(false);
    });

    it('sends the final notice on the next tick once still over limit after 100%', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50, 75, 90, 100], isOverLimit: true },
            { thresholdsSent: [50, 75, 90, 100] },
        );
        expect(decision.thresholdsToAlert).toEqual([]);
        expect(decision.sendFinalNotice).toBe(true);
        expect(decision.nextFinalNoticeSent).toBe(true);
        expect(decision.changed).toBe(true);
    });

    it('goes silent after the final notice has been sent', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50, 75, 90, 100], isOverLimit: true },
            { thresholdsSent: [50, 75, 90, 100], finalNoticeSent: true },
        );
        expect(decision.thresholdsToAlert).toEqual([]);
        expect(decision.sendFinalNotice).toBe(false);
        expect(decision.changed).toBe(false);
    });

    it('does not re-alert already-sent thresholds when spend dips back down', () => {
        const decision = decideSpendAlerts(
            { crossedThresholds: [50, 75, 90], isOverLimit: false },
            { thresholdsSent: [50, 75, 90, 100] },
        );
        expect(decision.thresholdsToAlert).toEqual([]);
        expect(decision.sendFinalNotice).toBe(false);
        expect(decision.changed).toBe(false);
    });
});
