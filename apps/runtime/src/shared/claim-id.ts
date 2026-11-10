import { createHash } from 'crypto';

/** A claim's id from its org and idempotency key: the hub names it so, and the worker reads its progress by it. */
export const claimIdFor = (organizationId: string, idempotencyKey: string) =>
    `claim-${createHash('sha256').update(`${organizationId}\0${idempotencyKey}`).digest('hex').slice(0, 24)}`;
