import type { BusinessValidationRequest } from '@libs/agents/business-validation/business-validation.types';
import type { RepositoryReader } from '@libs/agents/business-validation/judge/gap-check';
import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';
import { CodeManagementService } from '@libs/platform/infrastructure/adapters/services/codeManagement.service';

/** A large repository is listed once, up to this many files. */
const MAX_FILES = 5000;

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

    const reader: RepositoryReader = {
        listFiles: async (filter) => {
            paths ??= headRefOf()
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
                .then((files) => files.map((f) => f.path || f.filename))
                .catch(() => []);
            const needle = filter.trim().toLowerCase();
            return (await paths).filter(
                (path) => !needle || path.toLowerCase().includes(needle),
            );
        },
        readFile: async (path) => {
            const headRef = await headRefOf();
            if (!headRef) {
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
                        base: { ref: pullRequest.baseRef },
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
        },
    };
    return { ...request, repositoryReader: reader };
}
