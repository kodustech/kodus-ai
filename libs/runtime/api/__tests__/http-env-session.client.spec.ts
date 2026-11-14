import { ENV_SESSION_SIGNATURE_HEADER, envSessionKeyFrom, verifyEnvSessionRequest } from '@libs/runtime/contracts/env-session';
import { sealingKeyFrom } from '@libs/runtime/run/sealed-secret';

import { HttpEnvSessionClient } from '../infrastructure/http-env-session.client';
import { SEAL_KEY } from './fixtures';

const OWNER = { organizationId: 'o', teamId: 't', keyId: 'k', repositoryIds: ['r'] };
const ID = '11111111-1111-4111-8111-111111111111';

describe('HttpEnvSessionClient', () => {
    it('signs every call with the key derived from the seal key, over the exact path and body', async () => {
        const seen: any[] = [];
        const client = new HttpEnvSessionClient({ baseUrl: 'http://worker:3420/', secretSealKey: SEAL_KEY }, async (url, init) => {
            seen.push({ url, init });
            return { status: 200, text: async () => JSON.stringify({ stepId: ID, state: 'running' }) };
        });
        await client.step(OWNER, ID);
        const { url, init } = seen[0];
        expect(url).toBe(`http://worker:3420/env/steps/${ID}`);
        const key = envSessionKeyFrom(sealingKeyFrom(SEAL_KEY));
        expect(
            verifyEnvSessionRequest(key, init.headers[ENV_SESSION_SIGNATURE_HEADER], {
                method: 'POST',
                path: `/env/steps/${ID}`,
                body: init.body,
                now: Date.now(),
            }),
        ).toBe(true);
    });

    it('maps the worker answers: 404 stays 404, 429/409 keep their code, the rest is a plain 503', async () => {
        const answer = (status: number, body: unknown) =>
            new HttpEnvSessionClient({ baseUrl: 'http://w', secretSealKey: SEAL_KEY }, async () => ({ status, text: async () => JSON.stringify(body) }));
        await expect(answer(404, {}).status(OWNER, ID)).rejects.toMatchObject({ status: 404 });
        await expect(answer(429, { code: 'key_session_quota', message: 'm' }).status(OWNER, ID)).rejects.toMatchObject({
            status: 429,
            code: 'key_session_quota',
        });
        await expect(answer(401, { code: 'unauthorized' }).status(OWNER, ID)).rejects.toMatchObject({ status: 503, code: 'runtime_error' });
        const down = new HttpEnvSessionClient({ baseUrl: 'http://w', secretSealKey: SEAL_KEY }, async () => {
            throw new Error('ECONNREFUSED');
        });
        await expect(down.status(OWNER, ID)).rejects.toMatchObject({ status: 503, code: 'runtime_unreachable' });
    });

    it('answers 503 and calls nothing when the deployment has no env-session URL', async () => {
        const fetchImpl = jest.fn();
        await expect(new HttpEnvSessionClient({ secretSealKey: SEAL_KEY }, fetchImpl).status(OWNER, ID)).rejects.toMatchObject({
            status: 503,
            code: 'env_sessions_off',
        });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});
