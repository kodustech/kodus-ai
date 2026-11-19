import { isOnAlphaAllowList } from './alpha-allow-list';

describe('isOnAlphaAllowList', () => {
    it('lets everyone in on `*`', () => {
        expect(isOnAlphaAllowList(' * ', undefined)).toBe(true);
    });

    it('lets in the organizations it lists, however spaced', () => {
        expect(isOnAlphaAllowList('org-2, org-1 ,', 'org-1')).toBe(true);
        expect(isOnAlphaAllowList('org-2', 'org-1')).toBe(false);
    });

    it('lets no one in when unset or without an organization', () => {
        expect(isOnAlphaAllowList(undefined, 'org-1')).toBe(false);
        expect(isOnAlphaAllowList('', 'org-1')).toBe(false);
        expect(isOnAlphaAllowList('org-1', undefined)).toBe(false);
    });
});
