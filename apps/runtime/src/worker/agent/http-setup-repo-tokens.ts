import { SETUP_REPO_TOKENS_PATH, SetupRepoTokensResponseSchema, type SetupRepoTokensResponse } from '@libs/runtime/run/setup-repo-tokens';

import type { SecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';
import { failureName, postToProduct, unwrapProductBody } from './product-call';

/** Fresh sealed download tokens for one more boot of a setup (a repair, a learn boot), or why there are none. */
export type SetupRepoTokensOutcome = ({ status: 'issued' } & SetupRepoTokensResponse) | { status: 'unavailable'; message: string };

export interface SetupRepoTokensRequestInput {
    organizationId: string;
    /** The setup's token for the product, sealed to `setupKey`. */
    llmToken: string;
    setupKey: string;
    /** The boot the tokens are for: `boot` (the setup's first, its command's tokens run out or expired), `repair-<n>`, or `learn-<k>` for the learn loop's k-th clean boot. */
    attempt: string;
}

export interface SetupRepoTokensClient {
    /** Never throws: every failure is an `unavailable` outcome, so the step journals it. */
    refresh(req: SetupRepoTokensRequestInput): Promise<SetupRepoTokensOutcome>;
}

/**
 * POST /internal/runtime/setup-repo-tokens with the setup token
 * (libs/runtime/run/setup-repo-tokens.ts says what the product answers). The
 * tokens come back sealed for this setup and stay sealed: the client only
 * checks that each opens for it, never keeps or returns one opened.
 */
export class HttpSetupRepoTokensClient implements SetupRepoTokensClient {
    private readonly url: string;

    constructor(
        baseUrl: string,
        private readonly opts: { secrets: SecretOpener; fetch?: FetchLike; timeoutMs?: number; connectRetryDelaysMs?: readonly number[]; sleep?: (ms: number) => Promise<void> },
    ) {
        this.url = `${baseUrl.replace(/\/+$/, '')}/${SETUP_REPO_TOKENS_PATH}`;
    }

    async refresh(req: SetupRepoTokensRequestInput): Promise<SetupRepoTokensOutcome> {
        const unavailable = (message: string): SetupRepoTokensOutcome => ({ status: 'unavailable', message });
        let token: string;
        try {
            token = this.opts.secrets.open(req.llmToken, req.setupKey);
        } catch {
            return unavailable('the setup token does not open for this setup');
        }
        let answer: Awaited<ReturnType<typeof postToProduct>>;
        try {
            answer = await postToProduct(this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike), this.url, token, { attempt: req.attempt }, {
                timeoutMs: this.opts.timeoutMs ?? 30_000,
                connectRetryDelaysMs: this.opts.connectRetryDelaysMs,
                sleep: this.opts.sleep,
            });
        } catch (e) {
            return unavailable(`the product did not answer (${failureName(e)})`);
        }
        if (answer.res.status === 409) return unavailable('the product says this setup has finished');
        if (!answer.res.ok) return unavailable(`the product answered ${answer.res.status}`);
        const parsed = SetupRepoTokensResponseSchema.safeParse(unwrapProductBody(answer.body));
        if (!parsed.success) return unavailable('the product answered something that is not a set of download tokens');
        for (const sealed of [parsed.data.repoToken, ...(parsed.data.workspace ?? []).map((m) => m.sealedRepoToken)]) {
            try {
                this.opts.secrets.open(sealed, req.setupKey);
            } catch {
                return unavailable('the product answered tokens that do not open for this setup');
            }
        }
        return { status: 'issued', ...parsed.data };
    }
}
