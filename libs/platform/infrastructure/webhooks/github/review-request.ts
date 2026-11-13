import type { HostAccount } from '@libs/platform/domain/platformIntegrations/interfaces/code-management.interface';

/**
 * The account a "Request review" / "Re-request review" click names, when it
 * can be Kody: a `pull_request` event with action `review_requested`. A
 * request made to a team names no account. On a delivery of the GitHub App
 * (it carries `installation`) Kody is the App's bot, so a person named there
 * is somebody else, and is told so here, before any job or lookup.
 */
export function requestedReviewerOf(
    event: string,
    payload: any,
): HostAccount | null {
    if (event !== 'pull_request' || payload?.action !== 'review_requested') {
        return null;
    }
    const reviewer = payload?.requested_reviewer;
    if (!reviewer?.login || !reviewer?.node_id) return null;
    if (payload?.installation && reviewer.type !== 'Bot') return null;
    return reviewer;
}
