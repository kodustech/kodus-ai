import {
    SealedTokenError,
    sealedTokens,
} from '@libs/common/utils/sealed-token';

/**
 * The credential of an invitation link. The link used to carry the invited
 * user's id, which other responses expose, so anyone who learned it could
 * accept the invitation and set the account's password. The token is sealed
 * with a key of its own, names the user and the email it was sent to, and
 * expires; accepting still requires the invitation to be open.
 */

const KEY_LABEL = 'kodus/user-invitation/v1';
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InvitationClaims = { userId: string; email: string };

const tokens = sealedTokens<InvitationClaims>(KEY_LABEL, INVITATION_TTL_MS);

export function sealInvitation(
    claims: InvitationClaims,
    now = Date.now(),
): string {
    return tokens.seal(
        { userId: claims.userId, email: claims.email.toLowerCase() },
        now,
    );
}

/** The invitation a token names, or null when it is not one, or expired. */
export function openInvitation(
    token: unknown,
    now = Date.now(),
): InvitationClaims | null {
    try {
        const { userId, email } = tokens.open(token, now);
        return typeof userId === 'string' && typeof email === 'string'
            ? { userId, email }
            : null;
    } catch (err) {
        if (err instanceof SealedTokenError) return null;
        throw err;
    }
}

/** Whether `email` is the address an invitation was sent to. */
export function isInvitedEmail(
    claims: InvitationClaims,
    email: string | undefined,
): boolean {
    return !!email && email.toLowerCase() === claims.email;
}
