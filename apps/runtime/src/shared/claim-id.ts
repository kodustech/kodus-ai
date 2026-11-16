import { nulJoinedHex } from '@libs/runtime/contracts/derive-id';
import { SETUP_AUTHOR_REPAIRS_MAX } from '@libs/runtime/run/environment-setup';

/** A claim's id from its org and idempotency key: the hub names it so, and the worker reads its progress by it. */
export const claimIdFor = (organizationId: string, idempotencyKey: string) => `claim-${nulJoinedHex([organizationId, idempotencyKey], 24)}`;

/**
 * The claims a setup boots after its own (`setup:<key>:<suffix>`) on its
 * admission ticket's cell: the learn loop's attempts and their replays,
 * Kody's repairs of the setup's recipe, up to the setup's most
 * (SETUP_AUTHOR_REPAIRS_MAX), and the one boot again of the setup's own
 * boot or of a repair whose download was refused with expired tokens
 * (`refetch`, `repair-<n>:refetch`). Anything else is no child of the setup.
 */
export function isSetupChildSuffix(suffix: string): boolean {
    if (/^learn-[1-3](-replay)?$/.test(suffix) || suffix === 'refetch') return true;
    const repair = /^repair-([1-9]\d?)(?::refetch)?$/.exec(suffix);
    return !!repair && Number(repair[1]) <= SETUP_AUTHOR_REPAIRS_MAX;
}
