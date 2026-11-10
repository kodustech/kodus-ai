import { InMemoryRunTargetStore } from '@libs/runtime-publish/domain/run-target';

import { shopRunRequest } from './fixtures';
import { productPgConfig, recordProductTarget } from './product-target';


// ProcessEnv declares NODE_ENV as required; these are partial envs.
const env = (vars: Record<string, string>) => vars as NodeJS.ProcessEnv;
describe('e2e product target', () => {
    it('records the target the product would record for the request it built', async () => {
        const store = new InMemoryRunTargetStore();
        const req = shopRunRequest();
        await expect(recordProductTarget(req, { env: env({}), store })).resolves.toBe('recorded');
        expect(await store.get(req.runId)).toEqual({
            runId: req.runId,
            attempt: req.attempt,
            organizationId: req.organizationId,
            teamId: req.teamId,
            repositoryId: req.repository.id,
            repositoryName: req.repository.name,
            ...(req.repository.fullName ? { repositoryFullName: req.repository.fullName } : {}),
            platform: 'GITHUB',
            pullRequestNumber: req.pullRequest.number,
            headSha: req.pullRequest.headSha,
        });
    });

    it('skips without a product connection, and reads one from a URL or discrete variables', async () => {
        await expect(recordProductTarget(shopRunRequest(), { env: env({}) })).resolves.toBe('skipped');
        expect(productPgConfig(env({}))).toBeNull();
        expect(productPgConfig(env({ E2E_PRODUCT_DATABASE_URL: 'postgres://u@h/db' }))).toMatchObject({ connectionString: 'postgres://u@h/db' });
        expect(productPgConfig(env({ E2E_PRODUCT_PG_USER: 'kodus', E2E_PRODUCT_PG_DATABASE: 'kodus_db' }))).toMatchObject({
            host: 'db_postgres',
            port: 5432,
            user: 'kodus',
            database: 'kodus_db',
        });
    });
});
