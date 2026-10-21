import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { getMappedPlatform } from './index';

/**
 * Every code host must report the head commit on the mapped pull request.
 * LoadCiEvidenceStage reads `head.sha` to ask the host which checks ran on
 * that commit, and returns early when it is missing — so a normalizer that
 * omits it disables CI evidence for that whole platform, silently and
 * without an error anywhere.
 */
describe('mapped platform head.sha', () => {
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
                    base: { ref: 'main' },
                },
                repository: { full_name: 'acme/app' },
            },
            expected: 'gh-head-sha',
        },
        {
            platform: PlatformType.GITLAB,
            payload: {
                object_attributes: {
                    iid: 1,
                    source_branch: 'feature',
                    target_branch: 'main',
                    last_commit: { id: 'gl-head-sha' },
                },
                repository: { name: 'app' },
            },
            expected: 'gl-head-sha',
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
                        repository: { full_name: 'acme/app' },
                    },
                },
                repository: { full_name: 'acme/app' },
            },
            expected: 'bb-head-sha',
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
                        repository: { name: 'app' },
                    },
                },
            },
            expected: 'bb-dc-head-sha',
        },
        {
            platform: PlatformType.AZURE_REPOS,
            payload: {
                resource: {
                    pullRequestId: 1,
                    sourceRefName: 'refs/heads/feature',
                    targetRefName: 'refs/heads/main',
                    lastMergeSourceCommit: { commitId: 'az-head-sha' },
                    repository: { name: 'app' },
                },
            },
            expected: 'az-head-sha',
        },
    ];

    it.each(cases)(
        '$platform $label carries the head commit sha',
        ({ platform, payload, expected }) => {
            const mapped = getMappedPlatform(platform)?.mapPullRequest({
                payload: payload as never,
            });

            expect(mapped?.head?.sha).toBe(expected);
        },
    );
});
