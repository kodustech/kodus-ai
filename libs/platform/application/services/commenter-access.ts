import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import { OrganizationAndTeamData } from '@libs/core/infrastructure/config/types/general/organizationAndTeamData';
import type { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/** A pull request comment's webhook, as each platform sends it. */
export interface CommentWebhook {
    payload: any;
    platformType: PlatformType;
}

/** The repository a comment was posted on, as the code host is asked about it. */
export interface CommentRepository {
    name: string;
    id: string;
    owner?: string;
    /** Canonical provider path, e.g. GitLab's `namespace/project-slug`. */
    fullName?: string;
}

export function bareId(id: unknown): string | undefined {
    if (id === undefined || id === null || id === '') {
        return undefined;
    }
    return String(id).replace(/^\{|\}$/g, '');
}

/** The event's actor, as each platform names it. Forgejo has no case: see commenterOf. */
export function eventSenderOf(params: CommentWebhook): {
    login: string;
    id: string;
} {
    switch (params.platformType) {
        case PlatformType.GITHUB:
            return {
                login: params.payload?.sender?.login,
                id: params.payload?.sender?.id,
            };
        case PlatformType.GITLAB:
            return {
                login: params.payload?.user?.name,
                id: params.payload?.user?.id,
            };
        case PlatformType.BITBUCKET:
            // Data Center names its actor by `name` (the username its member
            // list is keyed by) and `displayName`.
            return {
                login:
                    params.payload?.actor?.display_name ||
                    params.payload?.actor?.nickname ||
                    params.payload?.actor?.displayName,
                id:
                    params.payload?.actor?.uuid?.slice(1, -1) ||
                    params.payload?.actor?.account_id ||
                    params.payload?.actor?.name,
            };
        case PlatformType.AZURE_REPOS:
            return {
                login: params.payload?.resource?.comment?.author?.displayName,
                id: params.payload?.resource?.comment?.author?.id,
            };
        default:
            return { login: '', id: '' };
    }
}

/** Who wrote the comment: Forgejo names the commenter as the event's `sender`. */
export function commenterOf(params: CommentWebhook): {
    login: string;
    id?: unknown;
} {
    if (params.platformType === PlatformType.FORGEJO) {
        const user = params.payload?.comment?.user ?? params.payload?.sender;
        return { login: user?.login ?? '', id: user?.id };
    }
    const sender = eventSenderOf(params);
    return { login: sender.login ?? '', id: sender.id };
}

function repositoryFromGitHubPullRequestUrl(params: CommentWebhook): {
    owner: string;
    name: string;
} {
    const pullRequestUrl = params.payload?.issue?.pull_request?.url;
    const match =
        typeof pullRequestUrl === 'string'
            ? pullRequestUrl.match(/\/repos\/([^/]+)\/([^/]+)\/pulls\/\d+/)
            : null;
    return match
        ? { owner: match[1], name: match[2] }
        : { owner: '', name: '' };
}

/** The repository the comment was posted on; empty on a platform not listed. */
export function commentRepositoryOf(params: CommentWebhook): CommentRepository {
    switch (params.platformType) {
        case PlatformType.GITHUB: {
            const fallback = repositoryFromGitHubPullRequestUrl(params);
            return {
                name: params.payload?.repository?.name || fallback.name || '',
                id: params.payload?.repository?.id,
                owner:
                    params.payload?.repository?.owner?.login ||
                    fallback.owner ||
                    '',
            };
        }
        case PlatformType.GITLAB:
            return {
                name: params.payload?.project?.name,
                id: params.payload?.project?.id,
                // `namespace` is GitLab's display name (for example,
                // "Junior Sartori"), not necessarily its URL path. Keep
                // the canonical path so GitLab clones use the project
                // slug, rather than an encoded display name.
                fullName: params.payload?.project?.path_with_namespace,
                owner:
                    params.payload?.project?.namespace ||
                    params.payload?.project?.path_with_namespace
                        ?.split('/')
                        ?.slice(0, -1)
                        ?.join('/') ||
                    '',
            };
        case PlatformType.BITBUCKET:
            return {
                name: params.payload?.repository?.name,
                id:
                    params.payload?.repository?.uuid?.slice(1, -1) ||
                    params.payload?.repository?.id,
                owner:
                    params.payload?.repository?.workspace?.slug ||
                    params.payload?.repository?.owner?.username ||
                    params.payload?.repository?.full_name?.split('/')?.at(0) ||
                    '',
            };
        case PlatformType.FORGEJO: {
            // ForgejoService reads `owner/repo` from `name`, as the
            // Forgejo webhook handler passes it.
            const fullName = params.payload?.repository?.full_name ?? '';
            return {
                name: fullName,
                id: params.payload?.repository?.id?.toString() ?? '',
                fullName,
                owner:
                    params.payload?.repository?.owner?.login ||
                    fullName.split('/').at(0) ||
                    '',
            };
        }
        case PlatformType.AZURE_REPOS:
            return {
                name: params.payload?.resource?.pullRequest?.repository?.name,
                id: params.payload?.resource?.pullRequest?.repository?.id,
                owner:
                    params.payload?.resource?.repository?.project?.name ||
                    params.payload?.resourceContainers?.project?.id ||
                    '',
            };
        default:
            return { name: '', id: '' };
    }
}

/**
 * Whether the comment's author has write access. GitHub and GitLab are asked
 * for the commenter's permission on the repository; the other platforms for
 * the organization's members. Throws when the lookup fails, the member list
 * comes back empty or the platform cannot say, so a caller never reads an
 * unknown as "no access".
 */
export async function commenterCanWrite(
    codeManagementService: Pick<
        CodeManagementService,
        'userCanWrite' | 'getListMembers'
    >,
    params: CommentWebhook,
    organizationAndTeamData: OrganizationAndTeamData,
    repository: CommentRepository = commentRepositoryOf(params),
): Promise<boolean> {
    const sender = commenterOf(params);
    if (params.platformType === PlatformType.GITHUB) {
        // The association rules out a contributor or a stranger, but
        // COLLABORATOR and MEMBER come with read access too: ask for the
        // permission.
        const association = params.payload?.comment?.author_association;
        if (
            !sender.login ||
            (typeof association === 'string' &&
                !['OWNER', 'MEMBER', 'COLLABORATOR'].includes(association))
        ) {
            return false;
        }
    }
    if (
        (params.platformType === PlatformType.GITHUB && sender.login) ||
        (params.platformType === PlatformType.GITLAB && sender.id)
    ) {
        // GitLab's listed members include Guests and Reporters: ask for
        // the level.
        const canWrite = await codeManagementService.userCanWrite(
            {
                organizationAndTeamData,
                repository: {
                    id: String(repository.id),
                    ...(params.platformType === PlatformType.GITHUB
                        ? { name: repository.name, owner: repository.owner }
                        : {}),
                },
                ...(params.platformType === PlatformType.GITHUB
                    ? { login: sender.login }
                    : { userId: sender.id as string | number }),
            },
            params.platformType,
        );
        if (canWrite === undefined) {
            throw new Error(
                `${params.platformType} could not say whether the commenter can write`,
            );
        }
        return canWrite;
    }
    // Bitbucket's display name is the user's to choose, so it is matched by
    // the id its members are listed by only: the Cloud uuid or the Data
    // Center username, never the `account_id` no member row carries.
    const bitbucket = params.platformType === PlatformType.BITBUCKET;
    const id = bitbucket
        ? bareId(params.payload?.actor?.uuid) ||
          bareId(params.payload?.actor?.name)
        : bareId(sender.id);
    const login = bitbucket ? undefined : sender.login?.toLowerCase();
    if (!id && !login) {
        throw new Error(
            `${params.platformType} named no commenter to check access for`,
        );
    }
    const members = await codeManagementService.getListMembers(
        { organizationAndTeamData, requireComplete: true },
        params.platformType,
    );
    // The providers answer a failed read with an empty list: no organization
    // with an integration has no members.
    if (!Array.isArray(members) || members.length === 0) {
        throw new Error(
            `${params.platformType} returned no members to check access against`,
        );
    }
    return members.some(
        (m: { id?: unknown; name?: unknown }) =>
            (!!id && bareId(m.id) === id) ||
            (!!login &&
                typeof m.name === 'string' &&
                m.name.toLowerCase() === login),
    );
}

/** Whether a review command's author can write: `unknown` when the code host could not say. */
export type ReviewCommandAccess = 'write' | 'none' | 'unknown';

const accessLogger = createLogger('ReviewCommandAccess');

/**
 * The access of who asked for a Heavy or Ultra review by command, the modes
 * that spend the most on the organization's keys: `unknown` when it could not
 * be read. Undefined for any other command: they need none.
 */
export async function reviewCommandAccess(
    codeManagementService: Pick<
        CodeManagementService,
        'userCanWrite' | 'getListMembers'
    >,
    params: CommentWebhook,
    organizationAndTeamData: OrganizationAndTeamData | undefined,
    requested: string | undefined,
): Promise<ReviewCommandAccess | undefined> {
    if (requested !== 'heavy' && requested !== 'ultra') return undefined;
    try {
        if (!organizationAndTeamData) {
            throw new Error('No organization to check access with');
        }
        return (await commenterCanWrite(
            codeManagementService,
            params,
            organizationAndTeamData,
        ))
            ? 'write'
            : 'none';
    } catch (error) {
        accessLogger.warn({
            message: `Could not read whether the author of a ${requested} review command can write`,
            context: 'ReviewCommandAccess',
            error,
            metadata: {
                organizationId: organizationAndTeamData?.organizationId,
                teamId: organizationAndTeamData?.teamId,
                platformType: params.platformType,
            },
        });
        return 'unknown';
    }
}
