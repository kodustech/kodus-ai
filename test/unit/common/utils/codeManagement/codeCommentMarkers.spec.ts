import {
    hasKodyMarker,
    hasReviewMarker,
    isForceReviewCommand,
    isKodyMentionNonReview,
    isReviewCommand,
} from '@libs/common/utils/codeManagement/codeCommentMarkers';

describe('codeCommentMarkers', () => {
    describe('isReviewCommand', () => {
        it('should return true for "@kody review"', () => {
            expect(isReviewCommand('@kody review')).toBe(true);
        });

        it('should return true for "@kody start-review"', () => {
            expect(isReviewCommand('@kody start-review')).toBe(true);
        });

        it('should return true with leading whitespace', () => {
            expect(isReviewCommand('  @kody review')).toBe(true);
            expect(isReviewCommand('\t@kody start-review')).toBe(true);
        });

        it('should return true case-insensitive', () => {
            expect(isReviewCommand('@KODY REVIEW')).toBe(true);
            expect(isReviewCommand('@Kody Start-Review')).toBe(true);
        });

        it('should return true with text after command', () => {
            expect(isReviewCommand('@kody review please')).toBe(true);
            expect(isReviewCommand('@kody start-review now')).toBe(true);
        });

        it('should return false for partial matches like "reviewing"', () => {
            expect(isReviewCommand('@kody reviewing')).toBe(false);
        });

        it('should return false for other @kody commands', () => {
            expect(isReviewCommand('@kody help')).toBe(false);
            expect(isReviewCommand('@kody explain')).toBe(false);
            expect(isReviewCommand('@kody what is this?')).toBe(false);
        });

        it('should return false when @kody is not at the start', () => {
            expect(isReviewCommand('hey @kody review')).toBe(false);
            expect(isReviewCommand('please @kody start-review')).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(isReviewCommand(null)).toBe(false);
            expect(isReviewCommand(undefined)).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(isReviewCommand('')).toBe(false);
        });
    });

    describe('hasReviewMarker', () => {
        it('should return true for standard kody-codereview marker', () => {
            expect(hasReviewMarker('<!-- kody-codereview -->')).toBe(true);
        });

        it('should return true with varying whitespace', () => {
            expect(hasReviewMarker('<!--kody-codereview-->')).toBe(true);
            expect(hasReviewMarker('<!--  kody-codereview  -->')).toBe(true);
        });

        it('should return true when marker is embedded in text', () => {
            expect(
                hasReviewMarker('Some text <!-- kody-codereview --> more text'),
            ).toBe(true);
        });

        it('should return true case-insensitive', () => {
            expect(hasReviewMarker('<!-- KODY-CODEREVIEW -->')).toBe(true);
            expect(hasReviewMarker('<!-- Kody-CodeReview -->')).toBe(true);
        });

        it('should return false when marker is not present', () => {
            expect(hasReviewMarker('no marker here')).toBe(false);
            expect(hasReviewMarker('<!-- other-marker -->')).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(hasReviewMarker(null)).toBe(false);
            expect(hasReviewMarker(undefined)).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(hasReviewMarker('')).toBe(false);
        });
    });

    describe('isKodyMentionNonReview', () => {
        it('should return true for @kody with other commands', () => {
            expect(isKodyMentionNonReview('@kody help')).toBe(true);
            expect(isKodyMentionNonReview('@kody explain this')).toBe(true);
            expect(isKodyMentionNonReview('@kody what is this?')).toBe(true);
        });

        it('should return true with leading whitespace', () => {
            expect(isKodyMentionNonReview('  @kody help')).toBe(true);
        });

        it('should return false for review commands', () => {
            expect(isKodyMentionNonReview('@kody review')).toBe(false);
            expect(isKodyMentionNonReview('@kody start-review')).toBe(false);
        });

        it('should return false for review commands case-insensitive', () => {
            expect(isKodyMentionNonReview('@kody REVIEW')).toBe(false);
            expect(isKodyMentionNonReview('@KODY start-review')).toBe(false);
        });

        it('should return false when @kody is not at the start', () => {
            expect(isKodyMentionNonReview('hey @kody help')).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(isKodyMentionNonReview(null)).toBe(false);
            expect(isKodyMentionNonReview(undefined)).toBe(false);
        });

        it('should return false for empty string', () => {
            expect(isKodyMentionNonReview('')).toBe(false);
        });

        it('should return true for @kody alone (just mention)', () => {
            expect(isKodyMentionNonReview('@kody')).toBe(true);
        });
    });

    describe('hasKodyMarker', () => {
        it('should return true for Code Review Completed marker', () => {
            expect(hasKodyMarker('## Code Review Completed! 🔥')).toBe(true);
        });

        it('should return true for critical issue marker', () => {
            expect(
                hasKodyMarker('# Found critical issues please fix them'),
            ).toBe(true);
        });

        it('should return true for @kody start patterns', () => {
            expect(hasKodyMarker('@kody start')).toBe(true);
            expect(hasKodyMarker('@kody start-review')).toBe(true);
        });

        it('should return true for @kody review pattern', () => {
            expect(hasKodyMarker('@kody review')).toBe(true);
        });

        it('should return true for kody without @ prefix', () => {
            expect(hasKodyMarker('kody start')).toBe(true);
            expect(hasKodyMarker('kody review')).toBe(true);
        });

        it('should return true for start-review alone', () => {
            expect(hasKodyMarker('start-review')).toBe(true);
        });

        it('should return false for regular comments', () => {
            expect(hasKodyMarker('This is a regular comment')).toBe(false);
            expect(hasKodyMarker('Please fix this bug')).toBe(false);
        });

        it('should return false for null/undefined', () => {
            expect(hasKodyMarker(null)).toBe(false);
            expect(hasKodyMarker(undefined)).toBe(false);
        });
    });

    describe('isForceReviewCommand', () => {
        it('should return true for "@kody review --force"', () => {
            expect(isForceReviewCommand('@kody review --force')).toBe(true);
        });

        it('should return true for "@kody start-review --force"', () => {
            expect(isForceReviewCommand('@kody start-review --force')).toBe(
                true,
            );
        });

        it('should accept single-dash and trailing text', () => {
            expect(isForceReviewCommand('@kody review -force')).toBe(true);
            expect(
                isForceReviewCommand('@kody review --force please retry'),
            ).toBe(true);
        });

        it('should be case-insensitive', () => {
            expect(isForceReviewCommand('@KODY REVIEW --FORCE')).toBe(true);
        });

        it('should return false for plain review commands', () => {
            expect(isForceReviewCommand('@kody review')).toBe(false);
            expect(isForceReviewCommand('@kody start-review')).toBe(false);
        });

        it('should not match "force" embedded mid-word', () => {
            expect(isForceReviewCommand('@kody review --forced')).toBe(false);
        });

        it('should return false for null/undefined/empty', () => {
            expect(isForceReviewCommand(null)).toBe(false);
            expect(isForceReviewCommand(undefined)).toBe(false);
            expect(isForceReviewCommand('')).toBe(false);
        });

        it('isReviewCommand should still match when --force is present', () => {
            // Force is a *flag on top of* a review command; both helpers
            // must agree so the handler still routes it as a review.
            expect(isReviewCommand('@kody review --force')).toBe(true);
            expect(isReviewCommand('@kody start-review --force')).toBe(true);
        });
    });

    describe('integration: command detection consistency', () => {
        it('should correctly identify review commands vs mentions', () => {
            const reviewCommands = [
                '@kody review',
                '@kody start-review',
                '  @kody review',
                '@KODY REVIEW',
            ];

            const nonReviewMentions = [
                '@kody help',
                '@kody explain',
                '@kody what is this code doing?',
                '@kody',
            ];

            reviewCommands.forEach((cmd) => {
                expect(isReviewCommand(cmd)).toBe(true);
                expect(isKodyMentionNonReview(cmd)).toBe(false);
            });

            nonReviewMentions.forEach((mention) => {
                expect(isReviewCommand(mention)).toBe(false);
                expect(isKodyMentionNonReview(mention)).toBe(true);
            });
        });

        it('should handle edge cases consistently', () => {
            // "reviewing" should not match as review command
            expect(isReviewCommand('@kody reviewing')).toBe(false);
            expect(isKodyMentionNonReview('@kody reviewing')).toBe(true);

            // "review-something" should not match as review command
            expect(isReviewCommand('@kody review-code')).toBe(false);
            expect(isKodyMentionNonReview('@kody review-code')).toBe(true);
        });
    });
});
