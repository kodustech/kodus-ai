import { isSearchable, searchCode } from './code-search';
import { windowedView } from './file-window';
import { directoryExistsCheck, isSecretFile, maskSecretAssignments, modelView, type RepoReader, RepoPathError, SECRET_VALUE_MARKER } from './repo-reader';

describe('secret files the model never reads', () => {
    it.each([
        'config/app.env',
        'prod.env',
        '.envrc',
        'infra/prod.tfvars',
        'infra/terraform.tfvars.json',
        'infra/terraform.tfstate',
        'infra/terraform.tfstate.backup',
        '.git-credentials',
        '.docker/config.json',
        'deploy/kubeconfig',
        'deploy/kubeconfig.yaml',
        '.kube/config',
        'src/Api/appsettings.Production.json',
        'src/main/resources/application-prod.properties',
    ])('withholds %s and keeps it out of search', (path) => {
        expect(isSecretFile(path)).toBe(true);
        expect(isSearchable(path)).toBe(false);
    });

    it.each(['.env.example', 'app.env.example', 'appsettings.json', 'src/main/resources/application.properties', 'docker/config.yaml', 'env.ts'])('still reads %s', (path) => {
        expect(isSecretFile(path)).toBe(false);
    });

    it('shows only the variable names of an env-style file', () => {
        const view = modelView('config/app.env', 'DB_HOST=db\nDB_PASSWORD=fake-value-1\n');
        expect(view).toContain('DB_PASSWORD');
        expect(view).not.toContain('fake-value-1');
        expect(modelView('.envrc', 'export API_TOKEN=fake-value-2\n')).toBe('[.envrc holds secrets; only its variable names are shown]\nAPI_TOKEN');
        expect(modelView('infra/prod.tfvars', 'db_password = "fake-value-3"')).not.toContain('fake-value-3');
    });
});

describe('secret-named values in configuration files', () => {
    it('masks KEY=VALUE and key: value lines whose key is secret-named', () => {
        const text = [
            'services:',
            '  db:',
            '    environment:',
            '      POSTGRES_PASSWORD: fake-value-4',
            '      - API_KEY=fake-value-5',
            '      POSTGRES_USER: app',
            '  "client_secret": "fake-value-6",',
            'export AUTH_TOKEN=fake-value-7',
            'ENV SESSION_SECRET=fake-value-8',
            'DATABASE_PASSWORD: ${DB_PASSWORD}',
        ].join('\n');
        const masked = maskSecretAssignments('docker-compose.yml', text);
        for (const v of ['fake-value-4', 'fake-value-5', 'fake-value-6', 'fake-value-7', 'fake-value-8']) expect(masked).not.toContain(v);
        expect(masked).toContain(`POSTGRES_PASSWORD: ${SECRET_VALUE_MARKER}`);
        expect(masked).toContain(`"client_secret": ${SECRET_VALUE_MARKER},`);
        expect(masked).toContain('POSTGRES_USER: app');
        // A reference to another variable holds no secret.
        expect(masked).toContain('DATABASE_PASSWORD: ${DB_PASSWORD}');
    });

    it('leaves source code alone', () => {
        const code = 'const password = req.body.password;';
        expect(maskSecretAssignments('src/auth.ts', code)).toBe(code);
    });

    it('applies to every view the model reads: whole file, window and search lines', () => {
        const text = 'spring.datasource.password=fake-value-9\nserver.port=8080\n';
        expect(modelView('src/main/resources/application.properties', text)).not.toContain('fake-value-9');
        expect(windowedView('src/main/resources/application.properties', text, {}, [], []).output).not.toContain('fake-value-9');
        expect(modelView('src/main/resources/application.properties', text)).toContain('server.port=8080');
    });

    it('masks a search match the same way', async () => {
        const files: Record<string, string> = { 'config.yaml': 'jwt_secret: fake-value-10\n' };
        const reader: RepoReader = { list: async () => Object.keys(files), read: async (p) => files[p] ?? null };
        const { matches } = await searchCode(reader, { text: 'jwt_secret' }, [], new Map());
        expect(matches).toEqual([`config.yaml:1: jwt_secret: ${SECRET_VALUE_MARKER}`]);
    });
});

describe('directoryExistsCheck', () => {
    const files = ['src/a.ts', 'packages/x/package.json'];
    const tree = (over: Partial<RepoReader> = {}): RepoReader => ({
        list: async (dir) => files.filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1)),
        read: async () => null,
        paths: async () => files,
        ...over,
    });

    it('answers only where the reader lists the whole tree: elsewhere an empty listing proves nothing', async () => {
        expect(await directoryExistsCheck(tree({ paths: undefined }))).toBeUndefined();
        const check = (await directoryExistsCheck(tree()))!;
        expect(await check('packages/x')).toBe(true);
        expect(await check('packages/gone')).toBe(false);
    });

    it('a refused path is no directory; a Git failure is thrown, never read as missing', async () => {
        const refused = (await directoryExistsCheck(tree({ list: async () => Promise.reject(new RepoPathError('the path leaves the repository')) })))!;
        expect(await refused('../x')).toBe(false);
        const down = (await directoryExistsCheck(tree({ list: async () => Promise.reject(new Error('502 from the Git API')) })))!;
        await expect(down('src')).rejects.toThrow('502');
        await expect(directoryExistsCheck(tree({ paths: async () => Promise.reject(new Error('502 from the Git API')) }))).rejects.toThrow('502');
    });
});
