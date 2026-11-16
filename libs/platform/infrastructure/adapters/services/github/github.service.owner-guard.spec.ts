import { ConfigService } from '@nestjs/config';

import { GithubService } from './github.service';

jest.mock('@libs/mcp-server/services/mcp-manager.service', () => ({
    MCPManagerService: jest.fn(),
}));

/**
 * Every GithubService method that talks to a repository, called the way
 * about a hundred callers do (the repository as `{ id, name }`, no owner),
 * must address GitHub under the owner the saved selection holds for it.
 *
 * Seen on QA for #2004: a token recorded under the user's login
 * (`sartorijr`) while the repository is `kodus-qa/school`; 43 of 43 methods
 * asked for `/repos/sartorijr/school/...` and got 404. Methods are found by
 * reading the class, so one added later is covered without listing it here.
 */
const STORED = [
    {
        id: '42',
        name: 'school',
        full_name: 'kodus-qa/school',
        organizationName: 'kodus-qa',
        http_url: 'https://github.com/kodus-qa/school',
    },
];

function makeOctokit(owners: string[]) {
    const record = (args: any) => {
        if (args && typeof args === 'object' && 'owner' in args) {
            owners.push(String(args.owner));
        }
    };
    const result = {
        data: {
            login: 'sartorijr',
            default_branch: 'main',
            sha: 'abc',
            commit: { sha: 'abc', tree: { sha: 'abc' } },
            object: { sha: 'abc' },
            tree: [],
            permission: 'admin',
            id: 1,
        },
        headers: {},
    };
    const handler: ProxyHandler<any> = {
        get(_t, prop) {
            if (prop === 'then') return undefined;
            if (prop === 'paginate') {
                const p: any = async (_fn: any, args: any) => {
                    record(args);
                    return [];
                };
                p.iterator = async function* (_fn: any, args: any) {
                    record(args);
                    yield* [];
                };
                return p;
            }
            if (prop === 'graphql' || prop === 'request') {
                return async (_q: any, vars: any) => {
                    record(vars);
                    return {};
                };
            }
            return new Proxy(function () {}, handler);
        },
        apply(_t, _this, args) {
            record(args[0]);
            return Promise.resolve(result);
        },
    };
    return new Proxy(function () {}, handler);
}

// These take the owner from the caller (`repository.owner`): the CI evidence
// stage, the risk map and the MCP issue tools pass it explicitly.
const EXPLICIT_OWNER = new Set(['getCheckEvidence', 'getIssue', 'listIssues']);

async function ownersSentByEveryMethod(auth: {
    org: string;
    authMode: string;
}): Promise<Record<string, string[]>> {
    const sent: Record<string, string[]> = {};
    const proto = GithubService.prototype as any;
    const names = Object.getOwnPropertyNames(proto).filter((n) => {
        if (n === 'constructor' || EXPLICIT_OWNER.has(n)) return false;
        const fn = proto[n];
        if (typeof fn !== 'function') return false;
        const src = fn.toString();
        return /owner/.test(src) && /repositor/.test(src);
    });

    for (const name of names) {
        const owners: string[] = [];
        const service = new GithubService(
            {
                getPlatformAuthDetails: jest.fn().mockResolvedValue({
                    ...auth,
                    accountType: 'organization',
                }),
                findOne: jest.fn().mockResolvedValue({ uuid: 'i' }),
            } as any,
            {} as any,
            {
                findOne: jest.fn().mockResolvedValue({ configValue: STORED }),
                createOrUpdateConfig: jest.fn(),
            } as any,
            {
                getFromCache: jest.fn().mockResolvedValue(null),
                addToCache: jest.fn(),
                removeFromCache: jest.fn(),
            } as any,
            { get: jest.fn() } as unknown as ConfigService,
        );
        (service as any).logger = {
            log() {},
            warn() {},
            error() {},
            debug() {},
            info() {},
        };
        jest.spyOn(service as any, 'instanceOctokit').mockResolvedValue(
            makeOctokit(owners),
        );
        jest.spyOn(service as any, 'instanceGraphQL').mockResolvedValue(
            async (_q: any, vars: any) => {
                if (vars?.owner) owners.push(String(vars.owner));
                return {};
            },
        );
        const repository = { id: '42', name: 'school' };
        const params: any = {
            organizationAndTeamData: { organizationId: 'o', teamId: 't' },
            repository,
            repositories: [repository],
            repositoryId: '42',
            repositoryName: 'school',
            prNumber: 1,
            pullRequestNumber: 1,
            commentId: 1,
            discussionId: '1',
            body: 'x',
            reaction: 'eyes',
            filters: { repository },
            lineComment: { path: 'a', line: 1, body: 'x' },
            commit: { sha: 'abc' },
            file: { filename: 'a', sha: 'abc' },
            files: [],
            branch: 'main',
            headSha: 'abc',
            sha: 'abc',
            path: 'a',
            filePath: 'a',
            paths: ['a'],
            title: 't',
            criticalComments: [],
        };
        try {
            await Promise.race([
                proto[name].call(service, params, params, params),
                new Promise((resolve) => setTimeout(resolve, 300)),
            ]);
        } catch {
            // Only the owners a method sends matter here.
        }
        if (owners.length) {
            sent[name] = [...new Set(owners)];
        }
    }
    return sent;
}

// Every method the probe reaches today. Each must keep sending an owner, so a
// method that stops reaching GitHub here fails instead of silently dropping
// out of the check; one added later is checked by `wrong` without a listing.
const PROBED = [
    'addReactionToComment',
    'addReactionToPR',
    'approvePullRequest',
    'createCommentInPullRequest',
    'createIssueComment',
    'createPullRequestWithFiles',
    'createResponseToComment',
    'createReviewComment',
    'diagnoseRepositoryAccess',
    'dismissOwnReviews',
    'getAllCommentsInPullRequest',
    'getChangedFilesSinceLastCommit',
    'getCommits',
    'getCommitsForPullRequestForCodeReview',
    'getDefaultBranch',
    'getFilePatches',
    'getFilesByPullRequestId',
    'getListOfValidReviews',
    'getPullRequest',
    'getPullRequestByNumber',
    'getPullRequestFilesAtCommit',
    'getPullRequestReviewComment',
    'getPullRequestReviewComments',
    'getPullRequestReviewThreads',
    'getPullRequests',
    'getPullRequestsByRepository',
    'getPullRequestsWithChangesRequested',
    'getRecentRepositoryComments',
    'getRepositoryAllFiles',
    'getRepositoryAllFilesWithContent',
    'getRepositoryTree',
    'getRepositoryTreeByDirectory',
    'getReviewStatusByPullRequest',
    'isWebhookActive',
    'mergePullRequest',
    'removeReactionsFromComment',
    'removeReactionsFromPR',
    'requestChangesPullRequest',
    'updateIssueComment',
    'updateResponseToComment',
    'uploadFiles',
];

const sentToAnotherOwner = (
    sent: Record<string, string[]>,
    expected: string,
): Array<[string, string[]]> =>
    Object.entries(sent).filter(([, owners]) =>
        owners.some((owner) => owner !== expected),
    );

describe('GithubService addresses every repository call by its saved owner', () => {
    it('a token recorded under another account', async () => {
        const sent = await ownersSentByEveryMethod({
            org: 'sartorijr',
            authMode: 'token',
        });

        expect(Object.keys(sent)).toEqual(expect.arrayContaining(PROBED));
        expect(sentToAnotherOwner(sent, 'kodus-qa')).toEqual([]);
    }, 120000);

    it('an App installation stays on its own account, whatever the saved selection holds', async () => {
        // The saved record names `kodus-qa`; the installation is `acme`. An
        // App only reaches its own account, so the selection lookup must not
        // reach it.
        const sent = await ownersSentByEveryMethod({
            org: 'acme',
            authMode: 'oauth',
        });

        expect(Object.keys(sent)).toEqual(expect.arrayContaining(PROBED));
        expect(sentToAnotherOwner(sent, 'acme')).toEqual([]);
    }, 120000);
});
