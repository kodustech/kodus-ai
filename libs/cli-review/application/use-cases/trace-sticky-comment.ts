/**
 * Sticky PR comment for Kodus Trace decisions.
 * One comment per PR, found by marker, updated in place. Omitted when empty.
 */

export const TRACE_STICKY_COMMENT_MARKER = '<!-- kodus-trace-decisions -->';

export interface StickyComment {
    id: string | number;
    body: string;
}

export interface TraceStickyDecision {
    id: string;
    type: string;
    decision: string;
    rationale?: string;
    paths?: string[];
}

export function renderTraceStickyCommentBody(
    decisions: TraceStickyDecision[],
    branch?: string,
): string {
    const lines = [
        TRACE_STICKY_COMMENT_MARKER,
        '## Kodus Trace',
        '',
        branch ? `Branch: \`${branch}\`` : '',
        '',
        'Reasoning captured while this change was written:',
        '',
        ...decisions.map((d) => {
            const why = d.rationale ? ` — _${d.rationale}_` : '';
            const paths =
                d.paths && d.paths.length > 0
                    ? ` (${d.paths.slice(0, 5).join(', ')})`
                    : '';
            return `- **${d.type}**: ${d.decision}${why}${paths}`;
        }),
        '',
        '_Updated automatically by Kodus Trace. Pin or forget decisions via `kodus trace`._',
    ].filter((l) => l !== undefined);
    return lines.join('\n');
}

/**
 * Decide whether to post, update, or skip.
 * - No decisions → skip (do not post)
 * - Existing marker comment → update in place
 * - No existing → create
 */
export function planTraceStickyComment(input: {
    decisions: TraceStickyDecision[];
    existingComments: StickyComment[];
    branch?: string;
}):
    | { action: 'skip' }
    | { action: 'create'; body: string }
    | { action: 'update'; commentId: string | number; body: string } {
    if (!input.decisions || input.decisions.length === 0) {
        return { action: 'skip' };
    }

    const body = renderTraceStickyCommentBody(input.decisions, input.branch);

    const existing = input.existingComments.find((c) =>
        (c.body || '').includes(TRACE_STICKY_COMMENT_MARKER),
    );

    if (existing) {
        return { action: 'update', commentId: existing.id, body };
    }
    return { action: 'create', body };
}
