import { createHash } from 'node:crypto';
import {
    createReviewContextDelivery,
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_SOURCE,
} from './review-context.types';

const reviewContext = {
    source: REVIEW_CONTEXT_SOURCE,
    contentType: REVIEW_CONTEXT_CONTENT_TYPE,
    body: 'CANARY α\nInspect abort cleanup.',
};

describe('createReviewContextDelivery', () => {
    it('returns auditable body-free SHA-256 and UTF-8 byte metadata', () => {
        const delivery = createReviewContextDelivery(
            reviewContext,
            'kodus-bug-review-agent',
            'finder',
        );

        expect(delivery).toEqual({
            source: REVIEW_CONTEXT_SOURCE,
            contentType: REVIEW_CONTEXT_CONTENT_TYPE,
            sha256: createHash('sha256')
                .update(reviewContext.body, 'utf8')
                .digest('hex'),
            utf8Bytes: Buffer.byteLength(reviewContext.body, 'utf8'),
            recipient: 'kodus-bug-review-agent',
            phase: 'finder',
        });
        expect(JSON.stringify(delivery)).not.toContain(reviewContext.body);
    });

    it('gives multiple recipients the same content identity', () => {
        const finder = createReviewContextDelivery(
            reviewContext,
            'kodus-general-review-agent',
            'finder',
        );
        const verifier = createReviewContextDelivery(
            reviewContext,
            'kodus-general-review-agent',
            'verifier',
        );

        expect(verifier.sha256).toBe(finder.sha256);
        expect(verifier.utf8Bytes).toBe(finder.utf8Bytes);
    });
});
