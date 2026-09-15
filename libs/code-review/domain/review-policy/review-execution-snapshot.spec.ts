import {
    createReviewExecutionSnapshot,
    hashReviewSnapshotValue,
} from './review-execution-snapshot';
import { DEFAULT_REVIEW_POLICY } from './review-policy';

describe('review execution snapshot', () => {
    it('hashes equivalent objects deterministically', () => {
        expect(hashReviewSnapshotValue({ b: 2, a: 1 })).toBe(
            hashReviewSnapshotValue({ a: 1, b: 2 }),
        );
    });

    it('stores rule and prompt fingerprints without storing their content', () => {
        const snapshot = createReviewExecutionSnapshot({
            policy: DEFAULT_REVIEW_POLICY,
            plan: {
                policyVersion: '1',
                strategy: 'risk-based',
                reviewMode: 'normal',
                risks: { bug: 0, security: 0, performance: 0 },
                totalChangedLines: 1,
                agents: [],
            },
            safeConfig: { reviewMode: 'normal' },
            promptOverrides: { review: 'private prompt text' },
            rules: [{ uuid: 'rule-2' }, { uuid: 'rule-1' }],
            model: { provider: 'openai', model: 'gpt-test' },
        });

        expect(snapshot.rules.ids).toEqual(['rule-1', 'rule-2']);
        expect(snapshot.promptHash).toHaveLength(64);
        expect(snapshot.rules.contentHash).toHaveLength(64);
        expect(JSON.stringify(snapshot)).not.toContain('private prompt text');
    });
});
