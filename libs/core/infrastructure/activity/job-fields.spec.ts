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
