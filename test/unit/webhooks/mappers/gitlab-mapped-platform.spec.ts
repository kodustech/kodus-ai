import { GitlabMappedPlatform } from '../../../../libs/common/utils/webhooks/gitlab';
import { IMappedPlatform } from '../../../../libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';

describe('GitlabMappedPlatform.mapPullRequest', () => {
    const platform: IMappedPlatform = new GitlabMappedPlatform();

    const buildMergeRequestPayload = (objectAttributes: object) => ({
        object_kind: 'merge_request',
        event_type: 'merge_request',
        object_attributes: {
            iid: 1,
            title: 'Test MR',
            description: 'description',
            source_branch: 'feature',
            target_branch: 'main',
            source: { path_with_namespace: 'org/repo' },
            target: {
                path_with_namespace: 'org/repo',
                default_branch: 'main',
            },
            labels: [],
            ...objectAttributes,
        },
        repository: { name: 'repo' },
        project: { id: 1, name: 'repo', path_with_namespace: 'org/repo' },
        user: { id: 1, username: 'user' },
    });

    it('maps draft null and work_in_progress true to draft', () => {
        const result = platform.mapPullRequest({
            payload: buildMergeRequestPayload({
                draft: null,
                work_in_progress: true,
            }),
        });

        expect(result?.isDraft).toBe(true);
    });

    it('maps omitted draft and work_in_progress true to draft', () => {
        const result = platform.mapPullRequest({
            payload: buildMergeRequestPayload({ work_in_progress: true }),
        });

        expect(result?.isDraft).toBe(true);
    });

    it('prefers explicit draft false over work_in_progress true', () => {
        const result = platform.mapPullRequest({
            payload: buildMergeRequestPayload({
                draft: false,
                work_in_progress: true,
            }),
        });

        expect(result?.isDraft).toBe(false);
    });

    it('maps note merge_request draft null and work_in_progress true to draft', () => {
        const result = platform.mapPullRequest({
            payload: {
                object_kind: 'note',
                event_type: 'note',
                object_attributes: { note: 'comment' },
                merge_request: {
                    iid: 2,
                    title: 'Comment MR',
                    description: 'desc',
                    draft: null,
                    work_in_progress: true,
                    source_branch: 'feature',
                    target_branch: 'main',
                    source: { path_with_namespace: 'org/repo' },
                    target: {
                        path_with_namespace: 'org/repo',
                        default_branch: 'main',
                    },
                    labels: [],
                },
                repository: { name: 'repo' },
                project: { id: 1, name: 'repo', path_with_namespace: 'org/repo' },
                user: { id: 1, username: 'user' },
            },
        });

        expect(result?.isDraft).toBe(true);
    });
});
