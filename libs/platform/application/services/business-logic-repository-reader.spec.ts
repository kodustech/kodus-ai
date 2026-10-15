import { withRepositoryReader } from './business-logic-repository-reader';

describe('withRepositoryReader', () => {
    const base = {
        door: 'command' as const,
        organizationAndTeamData: { organizationId: 'org-1' },
        repository: { id: 'r1', name: 'web' },
        diff: '',
    };
    const code = () => ({
        getPullRequest: jest.fn(async () => ({ head: { ref: 'feat/x' } })),
        getRepositoryAllFiles: jest.fn(async () => [
            { path: 'src/filter.ts' },
            { path: 'src/toolbar.tsx' },
        ]),
        getRepositoryContentFile: jest.fn(async () => ({
            data: {
                content: Buffer.from('a\nb').toString('base64'),
                encoding: 'base64',
            },
        })),
    });

    it("reads the PR's branch from the PR when a command's webhook didn't name it", async () => {
        const c = code();
        const request = withRepositoryReader(
            { ...base, pullRequest: { number: 7 } } as any,
            c as any,
        );
        await expect(
            request.repositoryReader!.listFiles('filter'),
        ).resolves.toEqual(['src/filter.ts']);
        await expect(
            request.repositoryReader!.readFile('src/filter.ts'),
        ).resolves.toBe('a\nb');
        expect(c.getPullRequest).toHaveBeenCalledTimes(1);
        expect(c.getRepositoryContentFile).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: expect.objectContaining({
                    head: { ref: 'feat/x' },
                }),
            }),
            undefined,
        );
    });

    it('leaves a request with no PR (a local diff) without a reader', () => {
        expect(
            withRepositoryReader(base as any, code() as any).repositoryReader,
        ).toBeUndefined();
    });
});
