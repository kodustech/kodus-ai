import { advisoryLockId } from './advisory-lock.repository';

describe('advisoryLockId', () => {
    // Computed with the release before leases (DistributedLockService.hashKey
    // on main): a pod of each release must take the same lock for one key.
    it.each([
        ['CODE_REVIEW:org-1:repo-1:42', [648727519, 96271179]],
        ['byok:org-1:slot:0', [1937244608, 1450588788]],
    ])('gives %s the key the previous release locks', (key, expected) => {
        expect(advisoryLockId(key)).toEqual(expected);
    });
});
