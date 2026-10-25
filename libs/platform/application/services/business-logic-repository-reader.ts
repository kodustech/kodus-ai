import type { BusinessValidationRequest } from '@libs/agents/business-validation/business-validation.types';
import type { RepositoryReader } from '@libs/agents/business-validation/judge/gap-check';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { createLogger } from '@libs/core/log/logger';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/** A large repository is listed once, up to this many files. */
const MAX_FILES = 5000;

const logger = createLogger('BusinessLogicRepositoryReader');

/**
 * The request with the repository at the PR head, read-only, so a MISSING
 * requirement can be looked for in code the diff doesn't show. The same on
 * every platform: each reads a file at `pullRequest.head.ref`. A request with
 * no PR (the CLI's local diff) is left as it is.
 */
export function withRepositoryReader(
    request: BusinessValidationRequest,
    code: CodeManagementService,
): BusinessValidationRequest {
    const { repository, pullRequest, organizationAndTeamData } = request;
    if (!repository?.id || !repository.name || !pullRequest?.number) {
        return request;
    }
    const type = request.platformType as PlatformType | undefined;
    const target = { id: repository.id, name: repository.name };
    let paths: Promise<string[]> | undefined;
    const files = new Map<string, Promise<string | undefined>>();
    // A failed read leaves the requirement MISSING; the log says why.
    const warn = (what: string, error: Error) =>
        logger.warn({
            message: `[BUSINESS-LOGIC] Couldn't ${what} at the PR head; the gap check sees less`,
            context: 'BusinessLogicRepositoryReader',
            error,
            metadata: {
                organizationId: organizationAndTeamData?.organizationId,
                repository: repository.name,
                prNumber: pullRequest.number,
            },
        });
    // A command's webhook (an issue comment) doesn't name the PR's branch:
    // it is read from the PR once, when the first file is.
    let branch: Promise<string | undefined> | undefined;
    const headRefOf = () =>
        (branch ??= pullRequest.headRef
            ? Promise.resolve(pullRequest.headRef)
            : code
                  .getPullRequest(
                      {
                          organizationAndTeamData,
                          repository: target,
                          prNumber: pullRequest.number,
                      },
                      type,
                  )
                  .then(
                      (pr) =>
                          (pr as { head?: { ref?: string } } | null)?.head?.ref,
                  )
                  .catch(() => undefined));

    const listAll = () =>
        (paths ??= headRefOf()
            .then((headRef) =>
                headRef
                    ? code.getRepositoryAllFiles(
                          {
                              organizationAndTeamData,
                              repository: target,
                              filters: {
                                  branch: headRef,
                                  maxFiles: MAX_FILES,
                              },
                          },
                          type,
                      )
                    : [],
            )
            .then((listed) => listed.map((f) => f.path || f.filename))
            .catch((error) => {
                warn('list the repository', error);
                return [];
            }));

    // Pinned to the head: both refs are the head, and a path the head's tree
    // doesn't list is not read, so an adapter that falls back to the base or
    // the default branch (GitLab does) never answers with code this PR removed.
    const readAtHead = async (path: string) => {
        const headRef = await headRefOf();
        const listed = await listAll();
        // A listing cut at MAX_FILES can't say a path is gone.
        const complete = listed.length > 0 && listed.length < MAX_FILES;
        if (!headRef || (complete && !listed.includes(path))) {
            return undefined;
        }
        const response = (await code.getRepositoryContentFile(
            {
                organizationAndTeamData,
                repository: target,
                file: { filename: path },
                pullRequest: {
                    number: pullRequest.number,
                    head: { ref: headRef },
                    base: { ref: headRef },
                },
            },
            type,
        )) as { data?: { content?: string; encoding?: string } } | null;
        const content = response?.data?.content;
        if (typeof content !== 'string') {
            return undefined;
        }
        return response?.data?.encoding === 'base64'
            ? Buffer.from(content, 'base64').toString('utf-8')
            : content;
    };

    const reader: RepositoryReader = {
        listFiles: async (filter) => {
            const needle = filter.trim().toLowerCase();
            return (await listAll()).filter(
                (path) => !needle || path.toLowerCase().includes(needle),
            );
        },
        readFile: (path) => {
            let file = files.get(path);
            if (!file) {
                file = readAtHead(path).catch((error) => {
                    warn(`read ${path}`, error);
                    return undefined;
                });
                files.set(path, file);
            }
            return file;
        },
    };
    return { ...request, repositoryReader: reader };
}
