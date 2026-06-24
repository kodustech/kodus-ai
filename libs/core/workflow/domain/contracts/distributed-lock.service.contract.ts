export const DISTRIBUTED_LOCK_SERVICE_TOKEN = Symbol('DistributedLockService');

export interface DistributedLockOptions {
    ttl?: number;
}

export interface IDistributedLock {
    release(): Promise<void>;

    isReleased(): boolean;
}

export interface IDistributedLockService {
    acquire(
        key: string,
        options?: DistributedLockOptions,
    ): Promise<IDistributedLock | null>;

    isLocked(key: string): Promise<boolean>;
}
