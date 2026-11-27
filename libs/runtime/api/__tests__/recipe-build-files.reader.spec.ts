import { AUTHORED_FILES_LIMITS } from '@libs/runtime/contracts/authored-files';

import { readCommittedBuildFiles } from '../application/recipe-build-files.reader';

const target = { organizationId: 'org', teamId: 'team', repositoryId: 'r1', repositoryName: 'acme/shop', sha: 'a'.repeat(40) };
const recipe = 'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n';

/** A repository at the commit: `tree` maps a path to its text; `list` false: the platform lists no tree. */
const gitWith = (tree: Record<string, string>, opts: { list?: boolean } = {}) => ({
    readFileAtCommit: jest.fn(async ({ path, maxBytes }: { path: string; maxBytes: number }) => {
        const text = tree[path];
        if (text === undefined) return null;
        if (Buffer.byteLength(text) > maxBytes) throw new Error('too large');
        return text;
    }),
    ...(opts.list === false ? {} : { listFilesAtCommit: jest.fn(async () => Object.keys(tree)) }),
});

describe('readCommittedBuildFiles', () => {
    it('reads the compose files the recipe names and the Dockerfiles beside them, in a fixed order', async () => {
        const git = gitWith({ '.kodus/workspace.yaml': recipe, '.kodus/compose.yaml': 'c\n', '.kodus/Dockerfile.app': 'FROM a\n', '.kodus/web.dockerfile': 'FROM w\n', '.kodus/README.md': 'x', 'src/Dockerfile': 'no' });
        expect(await readCommittedBuildFiles(git, target, recipe)).toEqual([
            { path: '.kodus/Dockerfile.app', content: 'FROM a\n' },
            { path: '.kodus/compose.yaml', content: 'c\n' },
            { path: '.kodus/web.dockerfile', content: 'FROM w\n' },
        ]);
    });

    it('reads only the named compose files when the platform lists no tree', async () => {
        const git = gitWith({ '.kodus/compose.yaml': 'c\n', '.kodus/Dockerfile.app': 'FROM a\n' }, { list: false });
        expect(await readCommittedBuildFiles(git, target, recipe)).toEqual([{ path: '.kodus/compose.yaml', content: 'c\n' }]);
    });

    it('finds nothing to send for a recipe whose compose file is not under .kodus/', async () => {
        const git = gitWith({ 'docker-compose.yml': 'c\n' });
        expect(await readCommittedBuildFiles(git, target, 'version: 1\nservices:\n  compose:\n    files: [docker-compose.yml]\n    public: app\n')).toBeUndefined();
    });

    it('sends none when the files pass the count, file or total bytes bounds, so the Run keeps today\'s behavior', async () => {
        const many: Record<string, string> = { '.kodus/compose.yaml': 'c\n' };
        for (let i = 0; i <= AUTHORED_FILES_LIMITS.files; i++) many[`.kodus/Dockerfile.s${i}`] = 'FROM a\n';
        expect(await readCommittedBuildFiles(gitWith(many), target, recipe)).toBeUndefined();

        const big = { '.kodus/compose.yaml': 'x'.repeat(AUTHORED_FILES_LIMITS.fileBytes + 1) };
        expect(await readCommittedBuildFiles(gitWith(big), target, recipe)).toBeUndefined();

        const each = 'x'.repeat(AUTHORED_FILES_LIMITS.fileBytes);
        const together: Record<string, string> = { '.kodus/compose.yaml': each };
        for (let i = 0; i < 3; i++) together[`.kodus/Dockerfile.s${i}`] = each;
        expect(await readCommittedBuildFiles(gitWith(together), target, recipe)).toBeUndefined();
    });

    it('sends none, and never throws, when the Git API fails or the platform cannot read a commit', async () => {
        const failing = { readFileAtCommit: jest.fn().mockRejectedValue(new Error('git 500')), listFilesAtCommit: jest.fn().mockResolvedValue(['.kodus/Dockerfile']) };
        await expect(readCommittedBuildFiles(failing, target, recipe)).resolves.toBeUndefined();
        const unsupported = { readFileAtCommit: jest.fn().mockResolvedValue('unsupported_platform'), listFilesAtCommit: jest.fn().mockResolvedValue('unsupported_platform') };
        await expect(readCommittedBuildFiles(unsupported, target, recipe)).resolves.toBeUndefined();
    });
});
