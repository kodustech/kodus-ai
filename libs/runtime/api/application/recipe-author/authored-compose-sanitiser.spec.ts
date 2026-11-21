import * as yaml from 'js-yaml';

import { sanitiseAuthoredCompose } from './authored-compose-sanitiser';
import { declareMirrorBuildArgs } from './authored-dockerfile-mirror';
import { checkAuthoredSubmission } from './authored-files-policy';

// What Kodus rewrites in a compose file Kody wrote under .kodus/ before the
// checks read it (research "Compose sanitiser instead of refusal"): only
// Kody's files, each change said back.

const REPO: Record<string, string> = {
    'package.json': '{"scripts":{"dev":"node server.js"}}',
    'server.js': 'require("http").createServer().listen(3000)',
    '.env.example': 'PORT=3000\n',
    'docker-compose.yml':
        'services:\n  app:\n    image: node:22\n    container_name: shop\n',
};
const exists = async (p: string) => p in REPO;
const read = async (p: string) => REPO[p] ?? null;
const DOCKERFILE =
    'FROM node:22-bookworm-slim\nWORKDIR /app\nCOPY package.json ./\nRUN npm install\nCOPY . .\nCMD ["npm", "run", "dev"]\n';
const RECIPE =
    'version: 1\nservices:\n  compose:\n    files: [.kodus/compose.yaml]\n    public: app\n  expose:\n    - { service: app, port: 3000, kind: http }\n';
const load = (text: string) =>
    yaml.load(text) as { services: Record<string, Record<string, unknown>> };

describe('sanitiseAuthoredCompose', () => {
    it('drops container_name and says so', async () => {
        const out = await sanitiseAuthoredCompose(
            '.kodus/compose.yaml',
            'services:\n  app:\n    image: node:22-bookworm-slim\n    container_name: shop-app\n',
            exists,
        );
        expect(load(out.content).services.app).toEqual({
            image: 'node:22-bookworm-slim',
        });
        expect(out.changes).toEqual([
            '.kodus/compose.yaml services.app.container_name: dropped (the cell names the containers of each claim)',
        ]);
    });

    it('inlines an extends of the same file: base first, the service over it, environment merged, lists joined', async () => {
        const text = `services:
  base:
    image: node:22-bookworm-slim
    environment: [NODE_ENV=development, PORT=3000]
    ports: ["3000"]
  app:
    extends: { service: base }
    environment: { PORT: "4000" }
    ports: ["9229"]
    command: npm run dev
  worker:
    extends: { service: app, file: .kodus/compose.yaml }
    command: npm run worker
`;
        const out = await sanitiseAuthoredCompose(
            '.kodus/compose.yaml',
            text,
            exists,
        );
        const s = load(out.content).services;
        expect(s.app).toEqual({
            image: 'node:22-bookworm-slim',
            environment: { NODE_ENV: 'development', PORT: '4000' },
            ports: ['3000', '9229'],
            command: 'npm run dev',
        });
        expect(s.worker).toMatchObject({
            image: 'node:22-bookworm-slim',
            command: 'npm run worker',
            environment: { PORT: '4000' },
        });
        expect(s.worker.extends).toBeUndefined();
        expect(out.changes).toEqual([
            '.kodus/compose.yaml services.app.extends: inlined service base of the same file (the cell reads no extends)',
            '.kodus/compose.yaml services.worker.extends: inlined service app of the same file (the cell reads no extends)',
        ]);
        // The file named from its own directory, as compose reads it, is the same file too.
        const rel = await sanitiseAuthoredCompose(
            '.kodus/compose.yaml',
            'services:\n  a:\n    image: redis:7\n  b:\n    extends: { service: a, file: compose.yaml }\n',
            exists,
        );
        expect(load(rel.content).services.b).toEqual({ image: 'redis:7' });
    });

    it('leaves an extends of another file, a cycle, or a missing base for the checks to refuse', async () => {
        for (const text of [
            'services:\n  app:\n    extends: { service: web, file: ../docker-compose.yml }\n',
            'services:\n  a:\n    extends: b\n  b:\n    extends: a\n',
            'services:\n  app:\n    extends: nope\n',
        ]) {
            const out = await sanitiseAuthoredCompose(
                '.kodus/compose.yaml',
                text,
                exists,
            );
            expect(out).toEqual({ content: text, changes: [] });
        }
    });

    it('drops the env_file entries whose file is not at the commit, keeps the ones that are', async () => {
        const out = await sanitiseAuthoredCompose(
            '.kodus/compose.yaml',
            'services:\n  app:\n    image: node:22-bookworm-slim\n    env_file: [.env, .env.example, { path: .env.local, required: false }]\n  db:\n    image: postgres:16\n    env_file: .env.db\n',
            exists,
        );
        const s = load(out.content).services;
        expect(s.app.env_file).toEqual(['.env.example']);
        expect(s.db.env_file).toBeUndefined();
        expect(out.changes).toEqual([
            '.kodus/compose.yaml services.app.env_file: dropped .env, which is not in the repository at this commit',
            '.kodus/compose.yaml services.app.env_file: dropped .env.local, which is not in the repository at this commit',
            '.kodus/compose.yaml services.db.env_file: dropped .env.db, which is not in the repository at this commit',
        ]);
    });

    it('a file with nothing to change, or that does not parse, comes back as written (comments kept)', async () => {
        for (const text of [
            '# Kody\nservices:\n  app:\n    image: node:22-bookworm-slim\n',
            'services: [nope',
            'not: compose\n',
        ]) {
            expect(
                await sanitiseAuthoredCompose(
                    '.kodus/compose.yaml',
                    text,
                    exists,
                ),
            ).toEqual({ content: text, changes: [] });
        }
    });
});

describe('checkAuthoredSubmission with the sanitiser', () => {
    const files = (compose: string) => [
        { path: '.kodus/Dockerfile', content: DOCKERFILE },
        { path: '.kodus/compose.yaml', content: compose },
    ];

    it("accepts Kody's compose file once rewritten, returns the rewritten text and what changed", async () => {
        const compose =
            'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n    container_name: shop\n    env_file: .env\n';
        const check = await checkAuthoredSubmission(
            RECIPE,
            files(compose),
            exists,
            read,
        );
        expect(check).toMatchObject({
            ok: true,
            adjusted: [
                expect.stringContaining('container_name: dropped'),
                expect.stringContaining('env_file: dropped .env'),
                // Once accepted, Kody's Dockerfile installs through the cell's mirror (G1).
                expect.stringContaining("installs only through the cell's read-only mirror"),
            ],
        });
        const app = load(
            check.files!.find((f) => f.path === '.kodus/compose.yaml')!.content,
        ).services.app;
        expect(app).toEqual({
            build: { context: '.', dockerfile: '.kodus/Dockerfile' },
        });
        // The Dockerfile is not a compose file: the sanitiser never touches it; only the mirror's build args are declared.
        expect(
            check.files!.find((f) => f.path === '.kodus/Dockerfile')!.content,
        ).toBe(declareMirrorBuildArgs('.kodus/Dockerfile', DOCKERFILE).content);
    });

    it('says what changed on a refusal too, and an env_file that is at the commit is still refused', async () => {
        const compose =
            'services:\n  app:\n    build: { context: ., dockerfile: .kodus/Dockerfile }\n    container_name: shop\n    env_file: .env.example\n';
        const check = await checkAuthoredSubmission(
            RECIPE,
            files(compose),
            exists,
            read,
        );
        expect(check.ok).toBe(false);
        expect(check.errors.join('\n')).toMatch(/env_file: refused/);
        expect(check.errors.join('\n')).not.toMatch(/container_name/);
        expect(check.adjusted).toEqual([
            expect.stringContaining('container_name: dropped'),
        ]);
    });

    it('never rewrites a repository compose file: the recipe naming one with container_name is checked as it is', async () => {
        const recipe = RECIPE.replace(
            '.kodus/compose.yaml',
            'docker-compose.yml',
        );
        const check = await checkAuthoredSubmission(
            recipe,
            undefined,
            exists,
            read,
        );
        expect(check.adjusted).toBeUndefined();
        expect(REPO['docker-compose.yml']).toContain('container_name: shop');
    });
});
