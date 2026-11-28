import { Inject, Injectable } from '@nestjs/common';

import {
    IRepositoryRepository,
    REPOSITORY_REPOSITORY_TOKEN,
} from '@libs/code-review/domain/contracts/RepositoryRepository.contract';
import { IRepositoryService } from '@libs/code-review/domain/contracts/RepositoryService.contract';

import {
    AstGraphStatus,
    RepositoryModel,
} from '../repositories/schemas/repository.model';

@Injectable()
export class RepositoryService implements IRepositoryService {
    constructor(
        @Inject(REPOSITORY_REPOSITORY_TOKEN)
        private readonly repositoryRepository: IRepositoryRepository,
    ) {}

    findOrCreate(params: {
        integrationConfigId: string;
        externalId: string;
        name: string;
        fullName: string;
        platform: string;
        defaultBranch?: string;
    }): Promise<RepositoryModel> {
        return this.repositoryRepository.findOrCreate(params);
    }

    findByExternalId(
        platform: string,
        externalId: string,
    ): Promise<RepositoryModel | null> {
        return this.repositoryRepository.findByExternalId(platform, externalId);
    }

    findById(uuid: string): Promise<RepositoryModel | null> {
        return this.repositoryRepository.findById(uuid);
    }

    updateGraphStatus(
        uuid: string,
        status: AstGraphStatus,
        extra?: {
            sha?: string;
            nodeCount?: number;
            edgeCount?: number;
        },
    ): Promise<void> {
        return this.repositoryRepository.updateGraphStatus(uuid, status, extra);
    }

    deferMergeDuringBuild(
        uuid: string,
        mergeSha: string | undefined,
    ): Promise<boolean> {
        return this.repositoryRepository.deferMergeDuringBuild(uuid, mergeSha);
    }

    clearMergeDeferredDuringBuild(
        uuid: string,
        mergeSha: string,
    ): Promise<void> {
        return this.repositoryRepository.clearMergeDeferredDuringBuild(
            uuid,
            mergeSha,
        );
    }
}
