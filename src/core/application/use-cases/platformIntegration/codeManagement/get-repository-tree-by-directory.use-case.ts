import { TreeItem } from '@/config/types/general/tree.type';
import { PinoLoggerService } from '@/core/infrastructure/adapters/services/logger/pino.service';
import { CodeManagementService } from '@/core/infrastructure/adapters/services/platformIntegration/codeManagement.service';
import { GetRepositoryTreeByDirectoryDto } from '@/core/infrastructure/http/dtos/get-repository-tree-by-directory.dto';
import {
    GET_ADDITIONAL_INFO_HELPER_TOKEN,
    IGetAdditionalInfoHelper,
} from '@/shared/domain/contracts/getAdditionalInfo.helper.contract';
import { IUseCase } from '@/shared/domain/interfaces/use-case.interface';
import { CacheService } from '@/shared/utils/cache/cache.service';
import { Inject, Injectable } from '@nestjs/common';

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
    constructor(
        private readonly codeManagementService: CodeManagementService,
        private readonly logger: PinoLoggerService,
        @Inject(GET_ADDITIONAL_INFO_HELPER_TOKEN)
        private readonly getAdditionalInfoHelper: IGetAdditionalInfoHelper,
        private readonly cacheService: CacheService,
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
                await this.getAdditionalInfoHelper.getRepositoryNameByOrganizationAndRepository(
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
