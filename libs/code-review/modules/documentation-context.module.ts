import { Module, forwardRef } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { DocumentationSearchCacheRepository } from '@libs/code-review/infrastructure/adapters/repositories/documentation-search-cache.repository';
import { DocumentationSearchCacheModelInstance } from '@libs/code-review/infrastructure/adapters/repositories/schemas/mongoose/documentationSearchCache.model';
import {
    DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
    DocumentationLLMPlannerService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-llm-planner.service';
import {
    DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
    DocumentationPackageDiscoveryService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-package-discovery.service';
import { DocumentationSearchCacheService } from '@libs/code-review/infrastructure/adapters/services/documentation-search-cache.service';
import {
    DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
    DocumentationSearchExaService,
} from '@libs/code-review/infrastructure/adapters/services/documentation-search-exa.service';
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
        // Token aliases so consumers can `@Inject(TOKEN)` per the
        // dependency-injection convention. Concrete-class injection
        // still works for legacy call sites.
        {
            provide: DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
            useExisting: DocumentationPackageDiscoveryService,
        },
        {
            provide: DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
            useExisting: DocumentationLLMPlannerService,
        },
        {
            provide: DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
            useExisting: DocumentationSearchExaService,
        },
    ],
    exports: [
        DocumentationPackageDiscoveryService,
        DocumentationLLMPlannerService,
        DocumentationSearchCacheService,
        DocumentationSearchExaService,
        DOCUMENTATION_PACKAGE_DISCOVERY_SERVICE_TOKEN,
        DOCUMENTATION_LLM_PLANNER_SERVICE_TOKEN,
        DOCUMENTATION_SEARCH_EXA_SERVICE_TOKEN,
    ],
})
export class DocumentationContextModule {}
