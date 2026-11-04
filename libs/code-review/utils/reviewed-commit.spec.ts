import { reviewedCommitIn } from './reviewed-commit';

describe('reviewedCommitIn', () => {
    const full = 'abcdef123456' + '0'.repeat(28);
    const other = { sha: 'f'.repeat(40) };

    it('finds the reviewed commit by its full sha', () => {
        expect(reviewedCommitIn([{ sha: full }, other], full)).toEqual({
            sha: full,
        });
    });

    it("finds it by Bitbucket's 12-character sha", () => {
        expect(
            reviewedCommitIn([{ sha: full }, other], 'abcdef123456'),
        ).toEqual({ sha: full });
    });

    it('does not match a prefix too short to name one commit', () => {
        expect(reviewedCommitIn([{ sha: full }, other], 'abc')).toBeUndefined();
    });

    it('returns nothing when the commit left the PR or none was given', () => {
        expect(reviewedCommitIn([other], full)).toBeUndefined();
        expect(reviewedCommitIn([other], undefined)).toBeUndefined();
    });
});
