import {
    AstGraphStatus,
    RepositoryModel,
} from '@libs/code-review/infrastructure/adapters/repositories/schemas/repository.model';

export const REPOSITORY_SERVICE_TOKEN = Symbol.for('RepositoryService');

export interface IRepositoryService {
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
}
