import { createLogger } from '@kodus/flow';
import { DocumentationSearchCacheRepository } from '@libs/code-review/infrastructure/adapters/repositories/documentation-search-cache.repository';
import { DocumentationItem } from '@libs/code-review/pipeline/context/code-review-pipeline.context';
import { Injectable } from '@nestjs/common';

const DOCUMENTATION_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class DocumentationSearchCacheService {
    private readonly logger = createLogger(
        DocumentationSearchCacheService.name,
    );

    constructor(
        private readonly cacheRepository: DocumentationSearchCacheRepository,
    ) {}

    async get(params: {
        provider: string;
        packageNameNormalized: string;
        queryNormalized: string;
    }): Promise<DocumentationItem | null> {
        try {
            const doc = await this.cacheRepository.findValidByKey({
                ...params,
                now: new Date(),
            });

            return (doc?.documentationItem as DocumentationItem) || null;
        } catch (error) {
            this.logger.warn({
                message: 'Failed to read documentation search cache entry',
                context: DocumentationSearchCacheService.name,
                error,
            });

            return null;
        }
    }

    async set(params: {
        provider: string;
        packageNameNormalized: string;
        queryNormalized: string;
        documentationItem: DocumentationItem;
    }): Promise<void> {
        try {
            await this.cacheRepository.upsertByKey({
                ...params,
                expiresAt: new Date(Date.now() + DOCUMENTATION_CACHE_TTL_MS),
            });
        } catch (error) {
            this.logger.warn({
                message: 'Failed to write documentation search cache entry',
                context: DocumentationSearchCacheService.name,
                error,
            });
        }
    }
}
