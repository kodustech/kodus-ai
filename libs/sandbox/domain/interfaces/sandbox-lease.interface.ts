export interface ISandboxLease {
    prKey: string;
    sandboxId?: string;
    leaseId: string;
    consumer: string;
    acquiredAt: Date;
    ttlMs: number;
}
