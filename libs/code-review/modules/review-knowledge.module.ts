import { PlatformModule } from '@libs/platform/modules/platform.module';
import { Module, forwardRef } from '@nestjs/common';

import {
    REPOSITORY_SKILL_DETECTION_SERVICE_TOKEN,
    RepositorySkillDetectionService,
} from '../infrastructure/agents/knowledge/skill-detection.service';

/**
 * Skills and docs that custom review agents and the main review are linked
 * to. The review-time pieces (resolver, prompt, tools) are plain classes built
 * per review; only the repository skill detection used by the API is a
 * provider.
 */
@Module({
    imports: [forwardRef(() => PlatformModule)],
    providers: [
        RepositorySkillDetectionService,
        {
            provide: REPOSITORY_SKILL_DETECTION_SERVICE_TOKEN,
            useExisting: RepositorySkillDetectionService,
        },
    ],
    exports: [
        RepositorySkillDetectionService,
        REPOSITORY_SKILL_DETECTION_SERVICE_TOKEN,
    ],
})
export class ReviewKnowledgeModule {}
