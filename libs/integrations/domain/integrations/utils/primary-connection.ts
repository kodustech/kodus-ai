import { IIntegration } from '../interfaces/integration.interface';

/**
 * The connection that keeps a workspace's plan and seats in billing: its
 * oldest, the one the workspace had before any other was added.
 */
export const primaryConnectionOf = <
    T extends Pick<IIntegration, 'uuid' | 'createdAt'>,
>(
    connections: T[],
): T | undefined =>
    [...connections].sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : Infinity;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : Infinity;
        return at - bt || a.uuid.localeCompare(b.uuid);
    })[0];
