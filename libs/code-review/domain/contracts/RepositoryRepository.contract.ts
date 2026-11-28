import {
    AstGraphStatus,
    RepositoryModel,
} from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';

export const REPOSITORY_REPOSITORY_TOKEN = Symbol.for('RepositoryRepository');

export interface IRepositoryRepository {
    findOrCreate(params: {
        integrationConfigId: string;
        externalId: string;
        name: string;
        fullName: string;
        platform: string;
        defaultBranch?: string;
    }): Promise<RepositoryModel>;

    findByExternalId(
        platform: string,
        externalId: string,
    ): Promise<RepositoryModel | null>;

    findById(uuid: string): Promise<RepositoryModel | null>;

    updateGraphStatus(
        uuid: string,
        status: AstGraphStatus,
        extra?: {
            sha?: string;
            nodeCount?: number;
            edgeCount?: number;
        },
    ): Promise<void>;
    /**
     * Remember a merge that arrived while a full build runs, so the build can
     * catch up once it publishes. Returns false when no build is running.
     */
    deferMergeDuringBuild(
        uuid: string,
        mergeSha: string | undefined,
    ): Promise<boolean>;
    /** Clear the deferred merge once its catch-up is settled, unless a newer one replaced it. */
    clearMergeDeferredDuringBuild(
        uuid: string,
        mergeSha: string,
    ): Promise<void>;
}
