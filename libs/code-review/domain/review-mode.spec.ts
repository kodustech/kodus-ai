import { agentReviewMode, isHeavyReview } from './review-mode';

describe('isHeavyReview', () => {
    it('follows the mode in settings when the command asks for none', () => {
        expect(isHeavyReview(undefined, 'heavy')).toBe(true);
        expect(isHeavyReview(undefined, 'balanced')).toBe(false);
        expect(isHeavyReview(undefined, undefined)).toBe(false);
    });

    it('lets the command override the mode in settings both ways', () => {
        expect(isHeavyReview('heavy', 'balanced')).toBe(true);
        expect(isHeavyReview('balanced', 'heavy')).toBe(false);
    });

    it('never runs a fast review heavy', () => {
        expect(isHeavyReview('heavy', 'fast')).toBe(false);
        expect(isHeavyReview(undefined, 'fast')).toBe(false);
    });
});

describe('agentReviewMode', () => {
    it('runs the agents of a heavy review as a balanced one', () => {
        expect(agentReviewMode('heavy')).toBe('balanced');
        expect(agentReviewMode('balanced')).toBe('balanced');
        expect(agentReviewMode(undefined)).toBe('balanced');
    });

    it('reads a legacy normal as balanced and keeps fast and deep', () => {
        expect(agentReviewMode('normal')).toBe('balanced');
        expect(agentReviewMode('fast')).toBe('fast');
        expect(agentReviewMode('deep')).toBe('deep');
    });
});
