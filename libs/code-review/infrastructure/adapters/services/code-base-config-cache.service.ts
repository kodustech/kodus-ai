import { createHash } from 'crypto';

import { createLogger } from '@libs/core/log/logger';
import { Injectable, Inject } from '@nestjs/common';

import {
    CODE_BASE_CONFIG_SERVICE_TOKEN,
    ICodeBaseConfigService,
} from '@libs/code-review/domain/contracts/CodeBaseConfigService.contract';
import {
    CodeReviewConfig,
    FileChange,
    Repository,
} from '@libs/core/infrastructure/config/types/general/codeReview.type';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import { CacheService } from '@libs/core/cache/cache.service';

@Injectable()
export class CodeBaseConfigCacheService {
    private readonly logger = createLogger(CodeBaseConfigCacheService.name);
    private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutos

    constructor(
        @Inject(CODE_BASE_CONFIG_SERVICE_TOKEN)
        private readonly codeBaseConfigService: ICodeBaseConfigService,
        private readonly cacheService: CacheService,
    ) {}

    /**
     * Busca configuração com cache
     */
    async getConfig(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Repository,
        files: FileChange[],
    ): Promise<CodeReviewConfig> {
        const cacheKey = this.getCacheKey(
            organizationAndTeamData,
            repository,
            files,
        );

        // Tentar buscar do cache
        const cached =
            await this.cacheService.getFromCache<CodeReviewConfig>(cacheKey);
        if (cached) {
            this.logger.debug({
                message: 'Config retrieved from cache',
                context: CodeBaseConfigCacheService.name,
                metadata: {
                    organizationId: organizationAndTeamData.organizationId,
                    repositoryId: repository.id,
                    cacheKey,
                },
            });
            return cached;
        }

        // Buscar do serviço
        const config = await this.codeBaseConfigService.getConfig(
            organizationAndTeamData,
            repository,
            files,
        );

        // Salvar no cache
        await this.cacheService.addToCache(cacheKey, config, this.CACHE_TTL);

        this.logger.debug({
            message: 'Config cached',
            context: CodeBaseConfigCacheService.name,
            metadata: {
                organizationId: organizationAndTeamData.organizationId,
                repositoryId: repository.id,
                cacheKey,
                ttl: this.CACHE_TTL,
            },
        });

        return config;
    }

    /**
     * Invalidar cache quando configuração muda
     */
    async invalidateCache(
        organizationId: string,
        repositoryId?: string,
    ): Promise<void> {
        // Por enquanto, limpar todo cache (pode ser otimizado depois)
        // TODO: Implementar invalidação seletiva por chave pattern
        await this.cacheService.clearCache();

        this.logger.log({
            message: 'Config cache invalidated',
            context: CodeBaseConfigCacheService.name,
            metadata: { organizationId, repositoryId },
        });
    }

    /**
     * Criar chave de cache única
     */
    private getCacheKey(
        organizationAndTeamData: OrganizationAndTeamData,
        repository: Repository,
        files: FileChange[],
    ): string {
        // Criar hash dos arquivos (ou apenas contagem se hash for muito caro)
        const filesHash = this.hashFiles(files);
        return `config:${organizationAndTeamData.organizationId}:${repository.id}:${filesHash}`;
    }

    /**
     * Hash dos arquivos para cache key
     * Usa hash simples baseado em nomes e tamanhos dos arquivos
     */
    private hashFiles(files: FileChange[]): string {
        // Criar string representando os arquivos
        const filesStr = files
            .map((f) => `${f.filename}:${f.additions || 0}:${f.deletions || 0}`)
            .sort()
            .join('|');

        // Hash MD5 (rápido e suficiente para cache key)
        return createHash('md5')
            .update(filesStr)
            .digest('hex')
            .substring(0, 16);
    }
}
