import {
    TRACE_STICKY_COMMENT_MARKER,
    planTraceStickyComment,
    renderTraceStickyCommentBody,
} from '../trace-sticky-comment';

describe('trace-sticky-comment', () => {
    const decisions = [
        {
            id: 'd1',
            type: 'tradeoff',
            decision: 'Chose consistency over latency',
            rationale: 'team convention',
            paths: ['src/a.ts'],
        },
    ];

    it('skips when there are no decisions', () => {
        const plan = planTraceStickyComment({
            decisions: [],
            existingComments: [],
        });
        expect(plan).toEqual({ action: 'skip' });
    });

    it('creates when no marker comment exists', () => {
        const plan = planTraceStickyComment({
            decisions,
            existingComments: [{ id: 1, body: 'unrelated review comment' }],
            branch: 'feat/x',
        });
        expect(plan.action).toBe('create');
        if (plan.action === 'create') {
            expect(plan.body).toContain(TRACE_STICKY_COMMENT_MARKER);
            expect(plan.body).toContain('Chose consistency over latency');
            expect(plan.body).toContain('feat/x');
        }
    });

    it('updates the marker comment in place on re-runs', () => {
        const existingBody = renderTraceStickyCommentBody(
            [{ id: 'old', type: 'other', decision: 'old decision' }],
            'feat/x',
        );
        const plan = planTraceStickyComment({
            decisions,
            existingComments: [
                { id: 42, body: existingBody },
                { id: 7, body: 'noise' },
            ],
            branch: 'feat/x',
        });
        expect(plan.action).toBe('update');
        if (plan.action === 'update') {
            expect(plan.commentId).toBe(42);
            expect(plan.body).toContain('Chose consistency over latency');
            expect(plan.body).toContain(TRACE_STICKY_COMMENT_MARKER);
            expect(plan.body).not.toContain('old decision');
        }
    });

    it('marker is stable for find-and-update', () => {
        expect(TRACE_STICKY_COMMENT_MARKER).toMatch(/^<!-- .+ -->$/);
    });
});
