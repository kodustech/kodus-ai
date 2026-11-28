import { PlatformType } from '@libs/core/domain/enums/platform-type.enum';

import { isOwnComment } from '../application/comment-publisher';
import { PlatformCommentAuthor } from './platform-comment-author';

const ORG = { organizationId: 'org-a', teamId: 'team-a' };

describe('PlatformCommentAuthor', () => {
    it("a GitHub App integration is known by the App, a token integration by its account's ids", async () => {
        const app = new PlatformCommentAuthor({ getCurrentUser: jest.fn().mockResolvedValue(null) }, () => 77);
        expect(await app.ownAuthor(ORG, PlatformType.GITHUB)).toEqual({ userIds: [], githubAppId: 77 });
        const gitlab = new PlatformCommentAuthor({ getCurrentUser: jest.fn().mockResolvedValue({ id: 42, username: 'kody' }) }, () => 77);
        expect(await gitlab.ownAuthor(ORG, PlatformType.GITLAB)).toEqual({ userIds: ['42'] });
        const bitbucket = new PlatformCommentAuthor({ getCurrentUser: jest.fn().mockResolvedValue({ uuid: 'abc', id: 'abc', account_id: 'acc-1' }) }, () => undefined);
        expect(await bitbucket.ownAuthor(ORG, PlatformType.BITBUCKET)).toEqual({ userIds: ['abc', 'acc-1'] });
    });

    it('says nothing when the platform cannot tell', async () => {
        const unknown = new PlatformCommentAuthor({ getCurrentUser: jest.fn().mockResolvedValue(null) }, () => undefined);
        expect(await unknown.ownAuthor(ORG, PlatformType.AZURE_REPOS)).toBeNull();
    });

    it('a comment is own only by the App id or an account id it carries; a PR author typing the marker is not', () => {
        expect(isOwnComment({ performed_via_github_app: { id: 77 }, user: { id: 9 } }, { userIds: [], githubAppId: 77 })).toBe(true);
        expect(isOwnComment({ performed_via_github_app: { id: 12 }, user: { id: 9 } }, { userIds: [], githubAppId: 77 })).toBe(false);
        expect(isOwnComment({ performed_via_github_app: null, user: { id: 5, login: 'kodus-fan' } }, { userIds: [], githubAppId: 77 })).toBe(false);
        expect(isOwnComment({ author: { id: 42 } }, { userIds: ['42'] })).toBe(true);
        expect(isOwnComment({ author: { id: 43 } }, { userIds: ['42'] })).toBe(false);
        expect(isOwnComment({ body: 'no author' }, { userIds: ['42'] })).toBe(false);
    });
});
