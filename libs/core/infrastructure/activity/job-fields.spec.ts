import { jobFields } from './job-fields';

describe('jobFields', () => {
    it.each([
        [
            'a code review job',
            {
                payload: {
                    organizationAndTeamData: { organizationId: 'o1' },
                    repository: { fullName: 'acme/app' },
                    pullRequest: { number: 12 },
                    platformType: 'GITHUB',
                },
            },
            {
                organizationId: 'o1',
                repository: 'acme/app',
                prNumber: 12,
                platform: 'GITHUB',
            },
        ],
        [
            // The shape EnqueueCodeReviewJobUseCase stores: the webhook body
            // under codeManagementPayload. The stale-job reaper logged these
            // with no repository or PR (prod, Nov 19).
            'a queued GitHub code review job',
            {
                organizationId: 'o3',
                payload: {
                    event: 'pull_request',
                    platformType: 'GITHUB',
                    organizationAndTeamData: { organizationId: 'o3' },
                    codeManagementPayload: {
                        action: 'synchronize',
                        pull_request: { number: 191 },
                        repository: { full_name: 'dw/quant-lab' },
                    },
                },
            },
            {
                organizationId: 'o3',
                repository: 'dw/quant-lab',
                prNumber: 191,
                platform: 'GITHUB',
            },
        ],
        [
            'a queued Bitbucket code review job',
            {
                payload: {
                    platformType: 'BITBUCKET',
                    codeManagementPayload: {
                        pullrequest: { id: 42 },
                        repository: { full_name: 'ws/repo' },
                    },
                },
            },
            { repository: 'ws/repo', prNumber: 42, platform: 'BITBUCKET' },
        ],
        [
            'a queued Azure code review job',
            {
                payload: {
                    platformType: 'AZURE_REPOS',
                    codeManagementPayload: {
                        resource: {
                            pullRequestId: 9,
                            repository: { name: 'az' },
                        },
                    },
                },
            },
            { repository: 'az', prNumber: 9, platform: 'AZURE_REPOS' },
        ],
        [
            'a raw GitHub webhook',
            {
                organizationId: 'o2',
                payload: {
                    payload: {
                        pull_request: { number: 8141 },
                        repository: { full_name: 'wv/app' },
                    },
                },
            },
            { organizationId: 'o2', repository: 'wv/app', prNumber: 8141 },
        ],
        [
            'a GitLab merge request webhook',
            {
                payload: {
                    payload: {
                        object_attributes: { iid: 5 },
                        project: { path_with_namespace: 'g/p' },
                    },
                },
            },
            { repository: 'g/p', prNumber: 5 },
        ],
        [
            'an Azure webhook',
            {
                payload: {
                    payload: {
                        resource: {
                            pullRequestId: 77,
                            repository: { name: 'r' },
                        },
                    },
                },
            },
            { repository: 'r', prNumber: 77 },
        ],
        [
            'the size of a GitHub PR from its webhook body',
            {
                payload: {
                    platformType: 'GITHUB',
                    codeManagementPayload: {
                        pull_request: {
                            number: 3,
                            changed_files: 14,
                            additions: 300,
                            deletions: 25,
                        },
                        repository: { full_name: 'acme/app' },
                    },
                },
            },
            {
                repository: 'acme/app',
                prNumber: 3,
                platform: 'GITHUB',
                changedFiles: 14,
                changedLines: 325,
            },
        ],
        ['an empty job', {}, {}],
    ])('reads %s', (_l, job, expected) => {
        const out = jobFields(job as any);
        expect(
            Object.fromEntries(
                Object.entries(out).filter(([, v]) => v !== undefined),
            ),
        ).toEqual(expected);
    });
});
