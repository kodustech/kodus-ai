import type { PublicPrMetadata } from '@libs/cli-review/infrastructure/services/github-public-pr.service';
import type { PublicPrGrouping } from '@libs/cli-review/infrastructure/services/public-pr-grouping.service';

export const PUBLIC_PR_GROUPING_SERVICE_TOKEN = Symbol.for(
    'PUBLIC_PR_GROUPING_SERVICE_TOKEN',
);

export interface IPublicPrGroupingService {
    generate(
        pr: PublicPrMetadata,
        diff: string,
        changedFiles: string[],
    ): Promise<PublicPrGrouping[] | undefined>;
}
