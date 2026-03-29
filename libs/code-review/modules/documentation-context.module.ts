import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { DocumentationSearchCacheRepository } from '@libs/code-review/infrastructure/adapters/repositories/documentation-search-cache.repository';
import { DocumentationSearchCacheModelInstance } from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/documentationSearchCache.model';
import { DocumentationLLMPlannerService } from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import { DocumentationPackageDiscoveryService } from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import { DocumentationSearchExaService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
import { CodebaseModule } from './codebase.module';

@Module({
    imports: [
        MongooseModule.forFeature([DocumentationSearchCacheModelInstance]),
        forwardRef(() => CodebaseModule),
    ],
    providers: [
        DocumentationPackageDiscoveryService,
        DocumentationLLMPlannerService,
        DocumentationSearchCacheRepository,
        DocumentationSearchCacheService,
        DocumentationSearchExaService,
    ],
    exports: [
        DocumentationPackageDiscoveryService,
        DocumentationLLMPlannerService,
        DocumentationSearchCacheService,
        DocumentationSearchExaService,
    ],
})
export class DocumentationContextModule {}
