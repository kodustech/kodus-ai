import { devSealKey } from '../../testing/dev-seal-key';
import { SealedSecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';
import { HttpRunPlanClient } from './http-run-plan';
import { LlmUnavailableError } from './llm-gateway';

const TOKEN = 'krt1.fake-run-token.sig';
const secrets = new SealedSecretOpener(devSealKey());
const call = { runId: 'run-1', organizationId: 'org-1', runToken: secrets.seal(TOKEN, 'run-1'), body: { round: 1 } as any };
const PLANNED = { status: 'no_plan', reason: 'nothing changed that runs', rejected: [], usage: { inputTokens: 1, outputTokens: 1 }, steps: 1 };
const net = (code: string) => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });

describe('HttpRunPlanClient', () => {
    it('sends again a planner round the product never received (it was restarting), never one that may have reached it', async () => {
        const slept: number[] = [];
        const sleep = async (ms: number) => void slept.push(ms);
        let calls = 0;
        const restarting: FetchLike = async () => {
            if (++calls < 3) throw net('ECONNREFUSED');
            return { status: 200, ok: true, json: async () => ({ statusCode: 200, type: 'Object', data: PLANNED }) };
        };
        await expect(new HttpRunPlanClient('http://api.test', { secrets, fetch: restarting, sleep, connectRetryDelaysMs: [1, 2, 3] }).plan(call)).resolves.toMatchObject({ status: 'no_plan' });
        expect(slept).toEqual([1, 2]);

        // The product may have run the planner's model turn: it is not deduplicated, so it is not sent again.
        let sent = 0;
        const timedOut: FetchLike = async () => {
            sent++;
            throw net('UND_ERR_HEADERS_TIMEOUT');
        };
        const err = await new HttpRunPlanClient('http://api.test', { secrets, fetch: timedOut, sleep, connectRetryDelaysMs: [1, 2, 3] }).plan(call).catch((e) => e);
        expect(err).toBeInstanceOf(LlmUnavailableError);
        expect(err.message).toBe('the test planner did not answer (TypeError: UND_ERR_HEADERS_TIMEOUT)');
        expect(sent).toBe(1);
    });
});
