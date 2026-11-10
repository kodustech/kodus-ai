import { readFileSync } from 'fs';
import { join } from 'path';

import { parseRecipeSummary, recipeDigest } from './recipe';
import { inferRecipe, type InferenceFiles, type RecipeInference } from './recipe-inference';

const compose = (text: string, extra: Omit<InferenceFiles, 'compose'> = {}): InferenceFiles => ({ compose: { path: 'docker-compose.yml', text }, ...extra });
const inferred = (r: RecipeInference) => {
    if (r.status !== 'inferred') throw new Error(`not inferred: ${r.message}`);
    return r;
};
const summary = (r: RecipeInference) => {
    const parsed = parseRecipeSummary(inferred(r).content);
    if ('error' in parsed) throw new Error(parsed.error);
    return parsed.recipe;
};

describe('inferRecipe', () => {
    it('reads the sample app compose: the built app on 3000 is public, the database is exposed for SQL probes', () => {
        const text = readFileSync(join(__dirname, '../../../experiments/kody-runtime/sample-app/app/docker-compose.yml'), 'utf8');
        const r = inferred(inferRecipe(compose(text)));
        expect(r).toMatchObject({ source: 'compose', public: 'app', port: 3000, health: '/health' });
        // What the hand-written sample recipe says, plus the database (pgvector is postgres).
        const handWritten = parseRecipeSummary(readFileSync(join(__dirname, '../../../experiments/kody-runtime/sample-app/app/.kodus/workspace.yaml'), 'utf8'));
        expect(handWritten).toMatchObject({ ok: true, recipe: { public: 'app', health: '/health', expose: [summary(r).expose[0]] } });
        expect(summary(r).expose).toEqual([
            { service: 'app', port: 3000, kind: 'http' },
            { service: 'db', port: 5432, kind: 'postgres' },
        ]);
    });

    it('writes a recipe the setup reads back: files, public, expose with the database', () => {
        const r = inferred(
            inferRecipe(
                compose(`
services:
  web:
    build: .
    ports: ["8080:3000"]
    depends_on: [db]
  db:
    image: postgres:16
    environment: { POSTGRES_PASSWORD: example }
`),
            ),
        );
        expect(r.content).toBe(
            [
                '# Kody Runtime recipe (docs §6), inferred by Kodus from docker-compose.yml.',
                '# Every value was read from that file; env values are test values and name themselves.',
                'version: 1',
                'services:',
                '  compose:',
                '    files: [docker-compose.yml]',
                '    public: web',
                '  expose:',
                '    - { service: web, port: 3000, kind: http }',
                '    - { service: db, port: 5432, kind: postgres }',
                '',
            ].join('\n'),
        );
        expect(summary(r)).toEqual({
            version: 1,
            public: 'web',
            expose: [
                { service: 'web', port: 3000, kind: 'http' },
                { service: 'db', port: 5432, kind: 'postgres' },
            ],
        });
    });

    it('is deterministic: the same files give the same text, so two setups share a digest (ENV-06)', () => {
        const text = 'services:\n  api: { build: ., ports: ["3000"] }\n  db: { image: mysql:8 }\n';
        const a = inferred(inferRecipe(compose(text)));
        const b = inferred(inferRecipe(compose(text)));
        expect(recipeDigest(a.content)).toBe(recipeDigest(b.content));
        expect(summary(a).expose).toEqual([
            { service: 'api', port: 3000, kind: 'http' },
            { service: 'db', port: 3306, kind: 'mysql' },
        ]);
    });

    it('prefers a service built from the repository, then the usual app port, over infrastructure', () => {
        const r = inferred(
            inferRecipe(
                compose(`
services:
  proxy: { image: nginx:1.27, ports: ["80:80", "443:443"] }
  app: { build: { context: . }, expose: ["5000"] }
  admin: { build: ./admin, ports: ["9999:9999"] }
  cache: { image: redis:7, ports: ["6379:6379"] }
  mail: { image: axllent/mailpit, ports: ["8025:8025"] }
`),
            ),
        );
        expect(r.public).toBe('app');
        expect(summary(r).expose).toEqual([
            { service: 'app', port: 5000, kind: 'http' },
            { service: 'proxy', port: 80, kind: 'http' },
            { service: 'admin', port: 9999, kind: 'http' },
        ]);
    });

    it('takes an image-only http service that serves the repository (nginx over ./site), and reads the long port syntax', () => {
        const r = inferred(inferRecipe(compose('services:\n  site:\n    image: nginx\n    volumes:\n      - ./site:/usr/share/nginx/html:ro\n    ports:\n      - target: 8080\n        published: 80\n')));
        expect(r).toMatchObject({ public: 'site', port: 8080 });
    });

    it('refuses an app that only runs a published image: the pull request would never run (umami)', () => {
        const r = inferRecipe(
            compose('services:\n  umami:\n    image: ghcr.io/umami-software/umami:latest\n    ports: ["3000:3000"]\n    volumes:\n      - umami-data:/data\n  db:\n    image: postgres:15-alpine\n'),
        );
        expect(r).toMatchObject({ status: 'not_inferred', reason: 'published_image' });
    });

    it('skips udp, ranges, TLS and unresolved ports, and keeps grpc as grpc', () => {
        const r = inferred(
            inferRecipe(
                compose(`
services:
  app:
    build: .
    ports: ["53:53/udp", "7000-7005:7000-7005", "8443:443", "3000:\${PORT}", "127.0.0.1:4000:4000", "50051:50051"]
`),
            ),
        );
        expect(summary(r).expose).toEqual([
            { service: 'app', port: 4000, kind: 'http' },
            { service: 'app', port: 50051, kind: 'grpc' },
        ]);
    });

    it('leaves out services under a profile (a plain compose up does not start them)', () => {
        const r = inferred(
            inferRecipe(compose('services:\n  app: { build: ., ports: ["3000"] }\n  debug: { build: ., ports: ["8080"], profiles: [debug] }\n')),
        );
        expect(summary(r).expose).toEqual([{ service: 'app', port: 3000, kind: 'http' }]);
    });

    it('takes the health path from the public service healthcheck, only on its own port', () => {
        const r = inferred(
            inferRecipe(
                compose(
                    'services:\n  app:\n    build: .\n    ports: ["3000"]\n    healthcheck:\n      test: ["CMD", "curl", "-f", "http://localhost:3000/api/health"]\n',
                ),
            ),
        );
        expect(summary(r)).toMatchObject({ public: 'app', health: '/api/health' });
        const other = inferred(
            inferRecipe(compose('services:\n  app:\n    build: .\n    ports: ["3000"]\n    healthcheck: { test: "wget -q http://127.0.0.1:9000/health" }\n')),
        );
        expect(other.health).toBeUndefined();
        // A path with characters a recipe path does not take is dropped, not escaped.
        const odd = inferred(
            inferRecipe(compose('services:\n  app:\n    build: .\n    ports: ["3000"]\n    healthcheck: { test: "curl http://localhost:3000/h?x=$(id)" }\n')),
        );
        expect(odd.health).toBeUndefined();
    });

    it('gives required compose variables a test value, never one that looks like a secret or controls what runs', () => {
        const r = inferred(
            inferRecipe(
                compose(`
services:
  app:
    build: .
    ports: ["3000"]
    environment:
      DATABASE_URL: \${DATABASE_URL:?set it}
      FEATURE: \${FEATURE?required}
      STRIPE_SECRET_KEY: \${STRIPE_SECRET_KEY:?}
      NODE_OPTIONS: \${NODE_OPTIONS:?}
      OPTIONAL: \${OPTIONAL:-x}
      LITERAL: $\${NOT_A_VAR:?}
`),
            ),
        );
        expect(r.env).toEqual(['DATABASE_URL', 'FEATURE']);
        expect(r.skippedEnv).toEqual(['NODE_OPTIONS', 'STRIPE_SECRET_KEY']);
        expect(r.content).toContain('    env:\n      DATABASE_URL: "http://kodus-fake.invalid"\n      FEATURE: "kodus-test-value"\n');
        expect(summary(r).public).toBe('app');
    });

    it('reads anchors and merge keys, as compose does', () => {
        const r = inferred(inferRecipe(compose('x-app: &app\n  build: .\n  ports: ["8000:8000"]\nservices:\n  api:\n    <<: *app\n')));
        expect(r).toMatchObject({ public: 'api', port: 8000 });
    });

    it('never copies a name it did not check: odd service names are skipped or quoted', () => {
        const r = inferred(
            inferRecipe(
                compose(
                    'services:\n  "bad name": { build: ., ports: ["3000"] }\n  "true": { build: ., ports: ["8080"] }\n  "-x": { build: ., ports: ["80"] }\n',
                ),
            ),
        );
        expect(r.public).toBe('true');
        expect(r.content).toContain('public: "true"');
        expect(r.content).not.toContain('bad name');
        expect(summary(r).expose).toEqual([{ service: 'true', port: 8080, kind: 'http' }]);
    });

    it('uses the root Dockerfile EXPOSE for a compose service built from it with no ports', () => {
        const r = inferred(
            inferRecipe(
                compose('services:\n  app: { build: . }\n', {
                    dockerfile: 'FROM python:3.12\nEXPOSE 8000\nHEALTHCHECK CMD curl -f http://localhost:8000/healthz || exit 1\n',
                }),
            ),
        );
        expect(summary(r)).toMatchObject({ public: 'app', health: '/healthz', expose: [{ service: 'app', port: 8000, kind: 'http' }] });
        // A service built from another Dockerfile does not borrow the root one's ports.
        const other = inferRecipe(
            compose('services:\n  app: { build: { context: ., dockerfile: Dockerfile.dev } }\n', { dockerfile: 'FROM node\nEXPOSE 3000\n' }),
        );
        expect(other).toEqual(expect.objectContaining({ status: 'not_inferred', reason: 'no_http_port' }));
    });

    it('says why when the compose file gives nothing to call', () => {
        expect(inferRecipe(compose('services:\n  cache: { image: redis, ports: ["6379:6379"] }\n'))).toEqual({
            status: 'not_inferred',
            reason: 'no_http_port',
            message: 'No service in docker-compose.yml declares an HTTP port Kodus can call (ports or expose), so no recipe was inferred.',
        });
        expect(inferRecipe(compose('services: [\n'))).toMatchObject({ status: 'not_inferred', reason: 'compose_unreadable' });
        expect(inferRecipe(compose('version: "3"\n'))).toMatchObject({ status: 'not_inferred', reason: 'compose_unreadable' });
        expect(inferRecipe(compose('services:\n  a: 1\n  a: 2\n'))).toMatchObject({ status: 'not_inferred', reason: 'compose_unreadable' });
    });

    it('with only a Dockerfile, exposes one service named app (the name the cell gives the project it builds)', () => {
        const r = inferred(
            inferRecipe({
                dockerfile:
                    'FROM node:22 AS build\nEXPOSE 9229\nFROM node:22-slim\nEXPOSE 8080/tcp 9229\nHEALTHCHECK --interval=5s CMD wget -qO- http://127.0.0.1:8080/ready\n',
            }),
        );
        expect(r).toMatchObject({ source: 'dockerfile', public: 'app', port: 8080, health: '/ready' });
        expect(r.content).not.toContain('files:');
        expect(summary(r)).toEqual({ version: 1, public: 'app', health: '/ready', expose: [{ service: 'app', port: 8080, kind: 'http' }] });
    });

    it('reads the final stage only: a builder stage port is not where the app listens', () => {
        const r = inferRecipe({ dockerfile: 'FROM golang AS build\nEXPOSE 7777\nFROM alpine\nENV PORT=4000\nCMD ["/app"]\n' });
        expect(r).toMatchObject({ status: 'inferred', port: 4000 });
        expect(inferRecipe({ dockerfile: 'FROM alpine\nENV NODE_ENV=production PORT 5000\n' })).toMatchObject({ port: 5000 });
        expect(inferRecipe({ dockerfile: 'FROM alpine\nHEALTHCHECK NONE\nEXPOSE \\\n  3000\n' })).toMatchObject({ port: 3000 });
    });

    it('takes a port from package.json when the Dockerfile names none', () => {
        const dockerfile = 'FROM node:22\nCMD ["npm", "start"]\n';
        expect(inferRecipe({ dockerfile, packageJson: JSON.stringify({ scripts: { start: 'node server.js --port 4321' } }) })).toMatchObject({ port: 4321 });
        expect(inferRecipe({ dockerfile, packageJson: JSON.stringify({ scripts: { start: 'PORT=5050 node index.js' } }) })).toMatchObject({ port: 5050 });
        const next = inferred(inferRecipe({ dockerfile, packageJson: JSON.stringify({ dependencies: { next: '15.0.0' } }) }));
        expect(next.port).toBe(3000);
        expect(next.content).toContain('inferred by Kodus from Dockerfile and package.json');
        expect(inferRecipe({ dockerfile, packageJson: '{not json' })).toMatchObject({ status: 'not_inferred', reason: 'no_http_port' });
        expect(inferRecipe({ dockerfile })).toEqual({
            status: 'not_inferred',
            reason: 'no_http_port',
            message: 'The Dockerfile has no EXPOSE or ENV PORT and package.json names no port, so Kodus cannot tell where the app listens.',
        });
    });

    it('has nothing to infer from without a compose file or a Dockerfile', () => {
        expect(inferRecipe({ packageJson: '{"dependencies":{"next":"15"}}' })).toEqual({
            status: 'not_inferred',
            reason: 'no_build_files',
            message: 'There is no compose file and no Dockerfile at the repository root, so Kodus has nothing to infer a recipe from.',
        });
    });

    it('caps the expose list at the 32 entries the recipe takes', () => {
        const services = Array.from({ length: 40 }, (_, i) => `  s${i}: { build: ., ports: ["${3000 + i}"] }`).join('\n');
        const r = inferred(inferRecipe(compose(`services:\n${services}\n`)));
        expect(summary(r).expose).toHaveLength(32);
    });
});
