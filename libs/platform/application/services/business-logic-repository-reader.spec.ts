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

    it('reads only at the head: never a path the head does not list, never the base', async () => {
        const c = code();
        const reader = withRepositoryReader(
            { ...base, pullRequest: { number: 7, headRef: 'feat/x' } } as any,
            c as any,
        ).repositoryReader!;
        // Removed by this PR: an adapter falling back to the base would find it.
        await expect(
            reader.readFile('src/removed.ts'),
        ).resolves.toBeUndefined();
        await reader.readFile('src/filter.ts');
        await reader.readFile('src/filter.ts');
        expect(c.getRepositoryContentFile).toHaveBeenCalledTimes(1);
        expect(c.getRepositoryContentFile).toHaveBeenCalledWith(
            expect.objectContaining({
                pullRequest: expect.objectContaining({
                    head: { ref: 'feat/x' },
                    base: { ref: 'feat/x' },
                }),
            }),
            undefined,
        );
    });

    it('answers nothing, without throwing, when the code host fails', async () => {
        const c = code();
        c.getRepositoryAllFiles.mockRejectedValue(new Error('401'));
        c.getRepositoryContentFile.mockRejectedValue(new Error('500'));
        const reader = withRepositoryReader(
            { ...base, pullRequest: { number: 7, headRef: 'feat/x' } } as any,
            c as any,
        ).repositoryReader!;
        await expect(reader.listFiles('')).resolves.toEqual([]);
        await expect(reader.readFile('src/filter.ts')).resolves.toBeUndefined();
    });

    it('answers nothing, without throwing, when only reading the file fails', async () => {
        const c = code();
        c.getRepositoryContentFile.mockRejectedValue(new Error('500'));
        const reader = withRepositoryReader(
            { ...base, pullRequest: { number: 7, headRef: 'feat/x' } } as any,
            c as any,
        ).repositoryReader!;
        await expect(reader.listFiles('filter')).resolves.toEqual([
            'src/filter.ts',
        ]);
        await expect(reader.readFile('src/filter.ts')).resolves.toBeUndefined();
        expect(c.getRepositoryContentFile).toHaveBeenCalledTimes(1);
    });

    it('leaves a request with no PR (a local diff) without a reader', () => {
        expect(
            withRepositoryReader(base as any, code() as any).repositoryReader,
        ).toBeUndefined();
    });
});
