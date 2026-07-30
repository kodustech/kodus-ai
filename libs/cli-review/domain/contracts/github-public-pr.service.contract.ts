import type { PublicPrMetadata } from '@libs/cli-review/infrastructure/services/github-public-pr.service';

export const GITHUB_PUBLIC_PR_SERVICE_TOKEN = Symbol.for(
    'GITHUB_PUBLIC_PR_SERVICE_TOKEN',
);

export interface IGitHubPublicPrService {
    fetch(prUrl: string): Promise<PublicPrMetadata>;
}
