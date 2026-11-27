import { AzureReposRequestHelper } from './azure-repos-request-helper';
import { AzureReposService } from './azureRepos.service';

const OLD = '/src/a.ts';
const NEW = '/src/b.ts';
const BODY = 'one\ntwo\nthree\n';

// The file only exists at its old path in the base and at its new path after.
function buildService(changeType: string, headBody: string) {
    const change = {
        changeType,
        originalPath: OLD,
        item: { path: NEW, gitObjectType: 'blob' },
    };
    const helper = {
        getPullRequestDetails: jest.fn().mockResolvedValue({
            id: 42,
            lastMergeTargetCommit: { commitId: 'base' },
            lastMergeSourceCommit: { commitId: 'head' },
        }),
        getIterations: jest.fn().mockResolvedValue([
            {
                id: 1,
                sourceRefCommit: { commitId: 'head' },
                commonRefCommit: { commitId: 'base' },
            },
        ]),
        getChanges: jest.fn().mockResolvedValue([change]),
        getCommitsForPullRequest: jest
            .fn()
            .mockResolvedValue([{ commitId: 'head' }]),
        getDiff: jest
            .fn()
            .mockResolvedValue({ changes: [change], allChangesIncluded: true }),
        getFileContent: jest.fn(async ({ filePath, commitId }) => {
            if (commitId === 'base' && filePath === OLD) {
                return { content: BODY };
            }
            if (commitId === 'head' && filePath === NEW) {
                return { content: headBody };
            }
            throw Object.assign(new Error('not found'), { status: 404 });
        }),
        mapAzureStatusToFileChangeStatus:
            AzureReposRequestHelper.prototype.mapAzureStatusToFileChangeStatus,
    };
    const service = new AzureReposService(
        {} as any,
        {} as any,
        {} as any,
        helper as any,
        {} as any,
        undefined,
    );
    jest.spyOn(service as any, 'getAuthDetails').mockResolvedValue({
        orgName: 'org',
        token: 'token',
    });
    jest.spyOn(service as any, 'getProjectIdFromRepository').mockResolvedValue(
        'project',
    );
    return service;
}

const params = {
    organizationAndTeamData: { organizationId: 'o', teamId: 't' } as any,
    repository: { id: 'repo', name: 'repo' },
    prNumber: 42,
};

const readers: Array<[string, (s: AzureReposService) => Promise<any>]> = [
    ['getFilesByPullRequestId', (s) => s.getFilesByPullRequestId(params)],
    [
        'getPullRequestFilesAtCommit',
        (s) =>
            s.getPullRequestFilesAtCommit({
                ...params,
                baseBranch: 'main',
                headSha: 'head',
            }),
    ],
    [
        'getChangedFilesSinceLastCommit',
        (s) =>
            s.getChangedFilesSinceLastCommit({
                ...params,
                lastCommit: { sha: 'base' },
            }),
    ],
];

describe.each(readers)('AzureReposService.%s — renamed files', (_, read) => {
    it('gives a rename-only file no changed lines', async () => {
        const [file] = await read(buildService('rename', BODY));

        expect(file).toMatchObject({
            filename: NEW,
            status: 'renamed',
            additions: 0,
            deletions: 0,
        });
        expect(file.patch).not.toContain('@@');
    });

    it('keeps only the edited lines of a renamed and edited file', async () => {
        const [file] = await read(
            buildService('edit, rename', 'one\n2\nthree\n'),
        );

        expect(file).toMatchObject({ additions: 1, deletions: 1 });
    });
});
