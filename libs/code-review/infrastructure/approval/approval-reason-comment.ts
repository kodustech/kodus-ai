export const APPROVAL_REASON_MARKER = '<!-- kodus-conditional-approval -->';

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
