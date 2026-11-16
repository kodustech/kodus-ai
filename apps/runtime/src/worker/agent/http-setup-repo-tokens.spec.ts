import { sealSecret } from '@libs/runtime/run';

import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import { HttpSetupRepoTokensClient } from './http-setup-repo-tokens';

const KEY = 'env-1:2026-11-11T12:00:00.000Z';
const secrets = new SealedSecretOpener(devSealKey());
const input = { organizationId: 'org-1', llmToken: sealSecret('kst1.setup-token', devSealKey(), KEY), setupKey: KEY, attempt: 'repair-1' };
const answering = (status: number, body: unknown, seen: Array<{ headers: Record<string, string>; body: string }> = []) =>
    new HttpSetupRepoTokensClient('https://api', {
        secrets,
        fetch: async (_url, init) => (seen.push({ headers: init.headers, body: init.body }), { status, ok: status < 300, json: async () => body }) as any,
    });

describe('fresh download tokens for a repair boot', () => {
    it('sends only the setup token and the attempt, and keeps the tokens sealed for this setup', async () => {
        const seen: Array<{ headers: Record<string, string>; body: string }> = [];
        const repoToken = sealSecret('ghs_fresh', devSealKey(), KEY);
        const out = await answering(200, { data: { repoToken } }, seen).refresh(input);

        expect(out).toEqual({ status: 'issued', repoToken });
        expect(seen[0].headers.authorization).toBe('Bearer kst1.setup-token');
        expect(JSON.parse(seen[0].body)).toEqual({ attempt: 'repair-1' });
    });

    it('refuses tokens sealed for another setup, and says when the setup has finished', async () => {
        const other = sealSecret('ghs_fresh', devSealKey(), 'another-setup');
        expect(await answering(200, { repoToken: other }).refresh(input)).toMatchObject({ status: 'unavailable', message: expect.stringContaining('do not open for this setup') });
        expect(await answering(409, { code: 'setup_finished' }).refresh(input)).toMatchObject({ status: 'unavailable', message: expect.stringContaining('finished') });
    });
});
