import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { resolveSessionConnection } from './postgres-connection-env';

it('a neutralized preview .env points the connection used by migrations and LISTEN at the stack’s own Postgres', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kodus-preview-pg-env-'));
    try {
        const env = join(dir, '.env');
        const template = join(dir, '.env.template');
        writeFileSync(
            env,
            [
                'DATABASE_URL=postgres://dev:private-developer-pass@shared-db.example:5432/kodus_db',
                'DATABASE_DIRECT_URL=postgres://dev:private-developer-pass@shared-db.example:5432/kodus_db',
                'API_PG_DB_HOST=db_postgres',
                'API_PG_DB_PORT=5432',
                'API_PG_DB_USERNAME=kodusdev',
                'API_PG_DB_PASSWORD=123456',
                'API_PG_DB_DATABASE=kodus_db',
            ].join('\n'),
        );
        writeFileSync(
            template,
            [
                'DATABASE_URL=op://test/DATABASE_URL/password',
                'DATABASE_DIRECT_URL=op://test/DATABASE_DIRECT_URL/password',
            ].join('\n'),
        );
        execFileSync(
            'bash',
            [
                resolve('scripts/preview/neutralize-preview-env.sh'),
                env,
                template,
            ],
            {
                env: {
                    ...process.env,
                    PREVIEW_SECRET_SEED: 'isolated-preview-fixture',
                },
                stdio: 'pipe',
            },
        );
        const text = readFileSync(env, 'utf8');
        const vars = Object.fromEntries(
            text
                .split('\n')
                .filter((line) => /^[A-Z_]+=/.test(line))
                .map((line) => {
                    const at = line.indexOf('=');
                    return [line.slice(0, at), line.slice(at + 1)];
                }),
        );

        expect(text).not.toContain('private-developer');
        expect(resolveSessionConnection(vars)).toMatchObject({
            host: 'db_postgres',
            port: 5432,
            database: 'kodus_db',
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
