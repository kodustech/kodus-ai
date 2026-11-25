export const APPROVAL_REASON_MARKER = '<!-- kodus-conditional-approval -->';

// GitHub writes wait in a per-installation queue (one comment every 3s). A
// raced write that loses still posts later, so a short bound records a failure
// for a comment that lands (#2534) and the cron, not finding it yet, posts a
// second one. The bound must exceed the queue; it only stops a stalled call.
export const APPROVAL_REASON_WRITE_TIMEOUT_MS = 90_000;

export function formatApprovalReasonComment(
    kind: 'approve' | 'hold',
    reason: string,
): string {
    const quotedReason = reason
        .split(/\r?\n/)
        .map((line) => `> ${line}`)
        .join('\n');
    return `${APPROVAL_REASON_MARKER}\n**Automatic approval ${kind === 'approve' ? 'completed' : 'held'}**\n\nKody's assessment:\n${quotedReason}`;
}

export function isApprovalReasonComment(comment: {
    body?: string;
    note?: string;
    content?: string;
}): boolean {
    const body = comment?.body ?? comment?.note ?? comment?.content;
    return typeof body === 'string' && body.includes(APPROVAL_REASON_MARKER);
}
