import { createLogger } from '@libs/core/log/logger';
import { CacheService } from '@libs/core/cache/cache.service';
import {
    CONTEXT_RESOLUTION_SERVICE_TOKEN,
    IContextResolutionService,
} from '@libs/core/context-resolution/domain/contracts/context-resolution.service.contract';
import { IUseCase } from '@libs/core/domain/interfaces/use-case.interface';
import { TreeItem } from '@libs/core/infrastructure/config/types/general/tree.type';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';
import { Inject, Injectable } from '@nestjs/common';
import { GetRepositoryTreeByDirectoryDto } from '@libs/platform/dtos/get-repository-tree-by-directory.dto';

export interface DirectoryItem {
    name: string;
    path: string;
    sha: string;
    hasChildren: boolean;
}

export interface RepositoryTreeByDirectoryResponse {
    repository: string | null;
    parentPath: string | null;
    currentPath: string | null;
    directories: DirectoryItem[];
}

@Injectable()
export class GetRepositoryTreeByDirectoryUseCase implements IUseCase {
    private readonly logger = createLogger(
        GetRepositoryTreeByDirectoryUseCase.name,
    );
    constructor(
        @Inject(CONTEXT_RESOLUTION_SERVICE_TOKEN)
        private readonly contextResolutionService: IContextResolutionService,
        private readonly cacheService: CacheService,
        private readonly codeManagementService: CodeManagementService,
    ) {}

    public async execute(
        params: GetRepositoryTreeByDirectoryDto & { organizationId: string },
    ): Promise<RepositoryTreeByDirectoryResponse> {
        try {
            const cacheKey = this.buildCacheKey(
                params.organizationId,
                params.teamId,
                params.repositoryId,
                params.directoryPath,
            );

            let directories: TreeItem[] = [];

            if (params.useCache) {
                const cached = await this.cacheService.getFromCache<{
                    directories: TreeItem[];
                }>(cacheKey);

                if (cached) {
                    directories = cached.directories;
                    this.logger.debug({
                        message:
                            'Repository tree by directory loaded from cache',
                        context: GetRepositoryTreeByDirectoryUseCase.name,
                        metadata: {
                            organizationId: params.organizationId,
                            repositoryId: params.repositoryId,
                            directoryPath: params.directoryPath || 'root',
                        },
                    });
                }
            }

            if (directories.length === 0) {
                directories =
                    await this.codeManagementService.getRepositoryTreeByDirectory(
                        {
                            organizationAndTeamData: {
                                organizationId: params.organizationId,
                                teamId: params.teamId,
                            },
                            repositoryId: params.repositoryId,
                            directoryPath: params.directoryPath,
                        },
                    );

                if (directories.length > 0) {
                    await this.cacheService.addToCache(
                        cacheKey,
                        { directories },
                        900_000,
                    );
                }
            }

            const formattedDirectories = this.formatDirectories(directories);
            const parentPath = this.getParentPath(params.directoryPath);

            const repositoryName =
                await this.contextResolutionService.getRepositoryNameByOrganizationAndRepository(
                    params.organizationId,
                    params.repositoryId,
                );

            return {
                repository: repositoryName,
                parentPath,
                currentPath: params.directoryPath || null,
                directories: formattedDirectories,
            };
        } catch (error) {
            this.logger.error({
                message: 'Error while getting repository tree by directory',
                context: GetRepositoryTreeByDirectoryUseCase.name,
                error,
                metadata: {
                    organizationId: params.organizationId,
                    repositoryId: params.repositoryId,
                    directoryPath: params.directoryPath,
                },
            });

            return {
                repository: null,
                parentPath: null,
                currentPath: params.directoryPath || null,
                directories: [],
            };
        }
    }

    private formatDirectories(treeItems: TreeItem[]): DirectoryItem[] {
        return treeItems.map((item) => {
            const name = item.path.split('/').pop()!;

            return {
                name,
                path: item.path,
                sha: item.sha,
                hasChildren: (item as any).hasChildren === true,
            };
        });
    }

    private getParentPath(currentPath?: string): string | null {
        if (!currentPath) {
            return null;
        }
        const parts = currentPath.split('/').filter(Boolean);
        if (parts.length <= 1) {
            return null;
        }
        return parts.slice(0, -1).join('/');
    }

    private buildCacheKey(
        organizationId: string,
        teamId: string,
        repositoryId: string,
        directoryPath?: string,
    ): string {
        const pathSegment = directoryPath
            ? `-${directoryPath.replace(/\//g, '-')}`
            : '-root';
        return `repo-tree-by-dir-${organizationId}-${teamId}-${repositoryId}${pathSegment}`;
    }
}
