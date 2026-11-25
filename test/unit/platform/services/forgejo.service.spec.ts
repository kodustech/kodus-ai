import { extractOwnerAndRepo } from '@libs/common/utils/helpers';

// Forgejo repositories are saved as "owner/repo" (the webhook's full_name);
// the service splits that back into the owner/repo pair its API URLs need.
describe('extractOwnerAndRepo', () => {
    it('should extract owner and repo from full name', () => {
        expect(extractOwnerAndRepo('kodustech/kodus-ai')).toEqual({
            owner: 'kodustech',
            repo: 'kodus-ai',
        });
    });

    it('should handle org-owned repos where owner equals repo name', () => {
        expect(extractOwnerAndRepo('acme/acme')).toEqual({
            owner: 'acme',
            repo: 'acme',
        });
    });

    it('should return null when only short name is provided', () => {
        expect(extractOwnerAndRepo('kodus-ai')).toBeNull();
    });

    it('should return null for empty string', () => {
        expect(extractOwnerAndRepo('')).toBeNull();
    });
});
