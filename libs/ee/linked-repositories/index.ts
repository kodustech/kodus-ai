/**
 * Linked repositories / cross-repo review context.
 *
 * Enterprise Code — see `license_ee.md`. Lives under `libs/ee/` and is
 * subject to the Kodus Enterprise License (not AGPL).
 *
 * Teams / Enterprise plan gated at runtime via
 * `isTeamsOrEnterpriseTierAllowed`.
 */

// Domain
export {
    MAX_LINKED_REPOSITORIES,
    type LinkedRepositoryConfig,
    type LinkedRepositoryStatus,
    type LinkedRefCandidate,
    type ResolvedLinkedRepository,
    type CrossRepoGateMetadata,
    type LinkedRepositoriesReviewMetadata,
    type LinkedRepoAccess,
} from './domain/linked-repository.types';

export {
    parsePrDescriptionOverrides,
    findOverrideForRepo,
    normalizeRepoKey,
    type PrDescriptionOverride,
} from './domain/parse-pr-description-overrides';

export {
    resolveLinkedRepositories,
    prHeadRefspecForPlatform,
    linkedRepoRootPath,
    slugifyRepo,
    type ConnectedRepository,
    type PrHeadRefspecResolver,
    type ResolveLinkedRepositoriesInput,
    type ResolveLinkedRepositoriesResult,
} from './domain/resolve-linked-repositories';

export {
    evaluateCrossRepoBoundaryGate,
    type CrossRepoGateSignalKind,
    type CrossRepoGateSignal,
    type CrossRepoBoundaryGateResult,
} from './domain/cross-repo-boundary-gate';

// Infrastructure
export {
    LazyLinkedRepoAccess,
    formatLinkedReposSummaryLine,
    type LinkedRepoCloneParams,
    type LinkedRepoAccessDeps,
} from './infrastructure/linked-repo-access';
