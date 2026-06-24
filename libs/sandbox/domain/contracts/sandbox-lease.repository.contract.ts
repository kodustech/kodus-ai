export const SANDBOX_LEASE_REPOSITORY_TOKEN = Symbol('SandboxLeaseRepository');

export interface SandboxLeaseRecord {
    _id: string;
    sandboxId?: string;
    state: string;
    leaseCount: number;
    createdAt: Date;
    expiresAt: Date;
    killAt?: Date;
}

export type SandboxLeaseLookup = Pick<
    SandboxLeaseRecord,
    '_id' | 'state' | 'sandboxId'
>;

export interface ISandboxLeaseRepository {
    upsertAcquire(
        prKey: string,
        leaseTtlMs: number,
        consumer?: string,
    ): Promise<SandboxLeaseRecord>;

    decrementLease(prKey: string): Promise<SandboxLeaseRecord | null>;

    updateReady(prKey: string, sandboxId: string): Promise<void>;

    markInvalidated(prKey: string): Promise<void>;

    findByPrKey(prKey: string): Promise<SandboxLeaseLookup | null>;

    findExpired(
        now: Date,
    ): Promise<Pick<SandboxLeaseRecord, '_id' | 'sandboxId' | 'state'>[]>;

    delete(prKey: string): Promise<void>;

    deleteIfNoActiveLeases(prKey: string): Promise<boolean>;

    setKillAt(prKey: string, killAt: Date): Promise<boolean>;

    clearKillAt(prKey: string): Promise<void>;

    findReadyToKill(
        now: Date,
    ): Promise<Pick<SandboxLeaseRecord, '_id' | 'sandboxId' | 'killAt'>[]>;
}
