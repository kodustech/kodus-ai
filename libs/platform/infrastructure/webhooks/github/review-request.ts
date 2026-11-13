import type { HostAccount } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

/**
 * The account a "Request review" / "Re-request review" click names: a
 * `pull_request` event with action `review_requested`. A request made to a
 * team names no account, and is never a request to Kody.
 */
export function requestedReviewerOf(
    event: string,
    payload: any,
): HostAccount | null {
    if (event !== 'pull_request' || payload?.action !== 'review_requested') {
        return null;
    }
    const reviewer = payload?.requested_reviewer;
    return reviewer?.login && reviewer?.node_id ? reviewer : null;
}
