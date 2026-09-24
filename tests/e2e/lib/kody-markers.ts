// Kody marks everything it posts with `<!-- kody-codereview -->`. Its
// conversation answers carry `<!-- kody-conversation -->` as well (#1946), so
// a poll looking for an answer can skip review output (findings, status
// comments) without also skipping the answer.
export function isKodyReviewOutput(body: string): boolean {
    return (
        body.includes('<!-- kody-codereview') &&
        !body.includes('<!-- kody-conversation')
    );
}

export function isKodyConversationAnswer(body: string): boolean {
    return body.includes('<!-- kody-conversation');
}
