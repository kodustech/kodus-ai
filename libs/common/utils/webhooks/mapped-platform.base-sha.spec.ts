import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { getMappedPlatform } from './index';

/**
 * A code host whose payload has the target-branch commit must report it on the
 * mapped pull request. AgentReviewStage keys the coding-agent instruction index
 * on `base.sha`; without it the review asks the host for the pull request
 * again. GitLab's payloads carry no target-branch commit, so it is left out.
 */
describe('mapped platform base.sha', () => {
    const cases: Array<{
        platform: PlatformType;
        label?: string;
        payload: unknown;
        expected: string;
    }> = [
        {
            platform: PlatformType.GITHUB,
            payload: {
                pull_request: {
                    number: 1,
                    head: { ref: 'feature', sha: 'gh-head-sha' },
                    base: { ref: 'main', sha: 'gh-base-sha' },
                },
                repository: { full_name: 'acme/app' },
            },
            expected: 'gh-base-sha',
        },
        {
            platform: PlatformType.FORGEJO,
            payload: {
                pull_request: {
                    number: 1,
                    head: { ref: 'feature', sha: 'fj-head-sha' },
                    base: { ref: 'main', sha: 'fj-base-sha' },
                },
                repository: { full_name: 'acme/app' },
            },
            expected: 'fj-base-sha',
        },
        {
            platform: PlatformType.BITBUCKET,
            payload: {
                isDataCenterEvent: false,
                pullrequest: {
                    id: 1,
                    source: {
                        branch: { name: 'feature' },
                        commit: { hash: 'bb-head-sha' },
                        repository: { full_name: 'acme/app' },
                    },
                    destination: {
                        branch: { name: 'main' },
                        commit: { hash: 'bb-base-sha' },
                        repository: { full_name: 'acme/app' },
                    },
                },
                repository: { full_name: 'acme/app' },
            },
            expected: 'bb-base-sha',
        },
        {
            platform: PlatformType.BITBUCKET,
            label: 'bitbucket data center',
            payload: {
                isDataCenterEvent: true,
                pullrequest: {
                    id: 1,
                    fromRef: {
                        displayId: 'feature',
                        latestCommit: 'bb-dc-head-sha',
                        repository: { name: 'app' },
                    },
                    toRef: {
                        displayId: 'main',
                        latestCommit: 'bb-dc-base-sha',
                        repository: { name: 'app' },
                    },
                },
            },
            expected: 'bb-dc-base-sha',
        },
        {
            platform: PlatformType.AZURE_REPOS,
            payload: {
                resource: {
                    pullRequestId: 1,
                    sourceRefName: 'refs/heads/feature',
                    targetRefName: 'refs/heads/main',
                    lastMergeSourceCommit: { commitId: 'az-head-sha' },
                    lastMergeTargetCommit: { commitId: 'az-base-sha' },
                    repository: { name: 'app' },
                },
            },
            expected: 'az-base-sha',
        },
    ];

    it.each(cases)(
        '$platform $label carries the target-branch commit sha',
        ({ platform, payload, expected }) => {
            const mapped = getMappedPlatform(platform)?.mapPullRequest({
                payload: payload as never,
            });

            expect(mapped?.base?.sha).toBe(expected);
        },
    );
});
