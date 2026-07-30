import type { PublicPrMetadata } from '@libs/cli-review/infrastructure/services/github-public-pr.service';

export const PUBLIC_PR_AI_SUMMARY_SERVICE_TOKEN = Symbol.for(
    'PUBLIC_PR_AI_SUMMARY_SERVICE_TOKEN',
);

export interface IPublicPrAiSummaryService {
    generate(
        pr: PublicPrMetadata,
        diff: string,
    ): Promise<string | undefined>;
}
