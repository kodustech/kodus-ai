import { BitbucketMappedPlatform } from '../../../../libs/common/utils/webhooks/bitbucket';
import { IMappedPlatform } from '../../../../libs/platform/domain/platformIntegrations/types/webhooks/webhooks-common.type';

describe('BitbucketMappedPlatform', () => {
    const platform: IMappedPlatform = new BitbucketMappedPlatform();

    /**
     * Bitbucket Data Center sends the pull request under `pullRequest`
     * (capital R), while Bitbucket Cloud sends `pullrequest` (lowercase).
     * See https://confluence.atlassian.com/bitbucketserver/event-payload-938025882.html
     *
     * `BitbucketController` normalizes the Data Center key before enqueueing,
     * so by the time the mapper runs the payload always carries `pullrequest`.
     */
    const buildDataCenterPayload = (overrides: object = {}) => ({
        eventKey: 'pr:opened',
        date: '2017-09-19T09:58:11+1000',
        actor: { name: 'admin', displayName: 'Administrator' },
        pullrequest: {
            id: 1,
            title: 'a new file added',
            description: 'description',
            state: 'OPEN',
            author: { user: { name: 'admin' } },
            reviewers: [],
            participants: [],
            fromRef: {
                id: 'refs/heads/a-branch',
                displayId: 'a-branch',
                repository: { id: 84, name: 'repo-1', slug: 'repo-1' },
            },
            toRef: {
                id: 'refs/heads/master',
                displayId: 'master',
                repository: { id: 84, name: 'repo-1', slug: 'repo-1' },
            },
            ...overrides,
        },
        isDataCenterEvent: true,
    });

    const buildCloudPayload = (overrides: object = {}) => ({
        pullrequest: {
            id: 7,
            title: 'cloud pr',
            description: 'description',
            author: { nickname: 'joe' },
            reviewers: [],
            participants: [],
            links: {
                html: { href: 'https://bitbucket.org/org/repo/pull-requests/7' },
            },
            source: {
                branch: { name: 'feature' },
                repository: { full_name: 'org/repo' },
            },
            destination: {
                branch: { name: 'main' },
                repository: { full_name: 'org/repo' },
            },
            ...overrides,
        },
        repository: {
            uuid: '{a1b2c3}',
            name: 'repo',
            full_name: 'org/repo',
            links: { html: { href: 'https://bitbucket.org/org/repo' } },
        },
        isDataCenterEvent: false,
    });

    describe('mapPullRequest', () => {
        it('maps a Data Center pull request using fromRef and toRef', () => {
            const result = platform.mapPullRequest({
                payload: buildDataCenterPayload(),
            });

            expect(result?.number).toBe(1);
            expect(result?.title).toBe('a new file added');
            expect(result?.head?.ref).toBe('a-branch');
            expect(result?.base?.ref).toBe('master');
            expect(result?.base?.repo?.fullName).toBe('repo-1');
        });

        it('maps a Cloud pull request using source and destination', () => {
            const result = platform.mapPullRequest({
                payload: buildCloudPayload(),
            });

            expect(result?.number).toBe(7);
            expect(result?.head?.ref).toBe('feature');
            expect(result?.base?.ref).toBe('main');
            expect(result?.url).toBe(
                'https://bitbucket.org/org/repo/pull-requests/7',
            );
        });

        it('maps missing draft to false', () => {
            const result = platform.mapPullRequest({
                payload: buildDataCenterPayload(),
            });

            expect(result?.isDraft).toBe(false);
        });

        it('returns null when the pull request is absent', () => {
            const payload = buildDataCenterPayload();
            delete (payload as any).pullrequest;

            expect(platform.mapPullRequest({ payload })).toBeNull();
        });

        it('returns null when isDataCenterEvent was not set by the controller', () => {
            const payload = buildDataCenterPayload();
            delete (payload as any).isDataCenterEvent;

            expect(platform.mapPullRequest({ payload })).toBeNull();
        });
    });

    describe('mapRepository', () => {
        it('maps a Data Center repository from toRef', () => {
            const result = platform.mapRepository({
                payload: buildDataCenterPayload(),
            });

            expect(result?.id).toBe('84');
            expect(result?.name).toBe('repo-1');
            expect(result?.fullName).toBe('repo-1');
        });

        it('maps a Cloud repository and strips curly braces from the uuid', () => {
            const result = platform.mapRepository({
                payload: buildCloudPayload(),
            });

            expect(result?.name).toBe('repo');
            expect(result?.fullName).toBe('org/repo');
        });

        it('returns null when the Data Center payload has no toRef repository', () => {
            const payload = buildDataCenterPayload();
            delete (payload as any).pullrequest.toRef;

            expect(platform.mapRepository({ payload })).toBeNull();
        });
    });

    describe('mapUsers', () => {
        it('maps the author of a Data Center pull request', () => {
            const result = platform.mapUsers({
                payload: buildDataCenterPayload(),
            });

            expect(result?.user).toEqual({ user: { name: 'admin' } });
        });

        it('returns null when the pull request is absent', () => {
            const payload = buildDataCenterPayload();
            delete (payload as any).pullrequest;

            expect(platform.mapUsers({ payload })).toBeNull();
        });
    });
});
