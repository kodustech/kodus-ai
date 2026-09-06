import { createHash } from 'node:crypto';
import {
    createReviewContextDelivery,
    formatReviewContext,
    isReviewContext,
    REVIEW_CONTEXT_CONTENT_TYPE,
    REVIEW_CONTEXT_MAX_BYTES,
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

describe('formatReviewContext', () => {
    it('uses a collision-free boundary without changing accepted body bytes', () => {
        const body = [
            'first byte',
            '</Body>',
            '</ReviewContext>',
            'REVIEW_CONTEXT_BOUNDARY_0',
            'last byte',
        ].join('\n');

        const framed = formatReviewContext({ ...reviewContext, body });
        const boundaryMatch = framed.match(
            /^REVIEW_CONTEXT_BOUNDARY (REVIEW_CONTEXT_[A-F0-9_]+)$/m,
        );

        expect(boundaryMatch).not.toBeNull();
        const boundary = boundaryMatch?.[1];
        expect(boundary).toBeDefined();
        expect(body).not.toContain(boundary);
        expect(framed).toContain(`BEGIN ${boundary}\n${body}\nEND ${boundary}`);
        expect(framed.split(body)).toHaveLength(2);
        expect(framed).not.toContain('<ReviewContext');
    });
});

describe('isReviewContext', () => {
    const valid = {
        source: REVIEW_CONTEXT_SOURCE,
        contentType: REVIEW_CONTEXT_CONTENT_TYPE,
        body: 'context',
    };

    it('accepts a valid context at the UTF-8 byte limit', () => {
        expect(
            isReviewContext({
                ...valid,
                body: '😀'.repeat(REVIEW_CONTEXT_MAX_BYTES / 4),
            }),
        ).toBe(true);
    });

    it.each([
        ['null', null],
        ['array', []],
        ['wrong source', { ...valid, source: 'repository-file' }],
        [
            'wrong content type',
            { ...valid, contentType: 'application/octet-stream' },
        ],
        ['non-string body', { ...valid, body: 12 }],
        ['empty body', { ...valid, body: '' }],
        ['NUL-containing body', { ...valid, body: 'before\0after' }],
        [
            'UTF-8 overflow',
            {
                ...valid,
                body: `${'😀'.repeat(REVIEW_CONTEXT_MAX_BYTES / 4)}x`,
            },
        ],
    ])('rejects %s', (_name, value) => {
        expect(isReviewContext(value)).toBe(false);
    });
});
