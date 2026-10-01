export const MESSAGE_CLAIM_SERVICE_TOKEN = Symbol.for('MessageClaimService');

/**
 * "First caller wins" across every instance, backed by the inbox table. Unlike
 * DistributedLockService it is not a mutex: once a key is claimed, a later
 * caller is refused even after the first one finished, which is what
 * de-duplicating repeated deliveries of the same event needs.
 */
export interface IMessageClaimService {
    /**
     * True when this caller is the first to claim `key` for `consumerId`;
     * false when another caller already holds or completed it. A claim left
     * unfinished (the holder died) can be taken again after
     * `expiresInMinutes`. Throws when the claim cannot be made at all.
     */
    claim(
        consumerId: string,
        key: string,
        options?: { expiresInMinutes?: number },
    ): Promise<boolean>;

    /** Marks the claim done, so it never expires into a second run. */
    complete(consumerId: string, key: string): Promise<void>;

    /** Gives the claim up after a failure, so a retry can claim it again. */
    release(consumerId: string, key: string): Promise<void>;
}
