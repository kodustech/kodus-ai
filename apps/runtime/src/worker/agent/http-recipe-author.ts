import { RECIPE_AUTHOR_PATH, type RecipeAuthorResponse, RecipeAuthorResponseSchema } from '@libs/runtime/contracts/recipe-author';

import type { SecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';

/**
 * What the setup's recipe step gets back: Kody's answer, or why there was
 * none. `unavailable` is not Kody's verdict (the product, the budget or the
 * model did not answer): the setup goes on as it would without Kody.
 */
export type RecipeAuthorOutcome = RecipeAuthorResponse | { status: 'unavailable'; code: 'llm_budget_exceeded' | 'llm_unavailable'; message: string };

/** The budget a 429 names, in the setup's words; a setup counts no pull request, so any other scope reads as its own. */
const spentBudget = (scope: unknown) => (scope === 'org_day' ? "the organization's LLM budget for today is spent" : "the setup's LLM budget is spent");

export interface RecipeAuthorRequestInput {
    organizationId: string;
    /** The setup's token for the product, sealed to `setupKey` (as the learn loop's). */
    llmToken: string;
    setupKey: string;
    sha: string;
}

export interface RecipeAuthorClient {
    /** Never throws: every failure is an `unavailable` outcome, so the step journals it. */
    author(req: RecipeAuthorRequestInput): Promise<RecipeAuthorOutcome>;
}

/**
 * POST /internal/runtime/recipe-author with the setup token (ADR-057): the
 * agent runs in the product, with the org's key, which never reaches the
 * worker. The token arrives sealed to the setup and is opened here, inside
 * the step that makes the call; it travels only in the Authorization header
 * and is never echoed in an outcome.
 */
export class HttpRecipeAuthorClient implements RecipeAuthorClient {
    private readonly url: string;

    constructor(
        baseUrl: string,
        private readonly opts: { secrets: SecretOpener; fetch?: FetchLike; timeoutMs?: number },
    ) {
        this.url = `${baseUrl.replace(/\/+$/, '')}/${RECIPE_AUTHOR_PATH}`;
    }

    async author(req: RecipeAuthorRequestInput): Promise<RecipeAuthorOutcome> {
        const unavailable = (message: string, code: 'llm_budget_exceeded' | 'llm_unavailable' = 'llm_unavailable'): RecipeAuthorOutcome => ({
            status: 'unavailable',
            code,
            message,
        });
        if (!req.llmToken) return unavailable('the setup carries no token for the product');
        let token: string;
        try {
            token = this.opts.secrets.open(req.llmToken, req.setupKey);
        } catch {
            return unavailable('the setup token does not open for this setup');
        }
        const doFetch = this.opts.fetch ?? (globalThis.fetch as unknown as FetchLike);
        let res: Awaited<ReturnType<FetchLike>>;
        try {
            res = await doFetch(this.url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ sha: req.sha }),
                signal: AbortSignal.timeout(this.opts.timeoutMs ?? 360_000),
            });
        } catch (e) {
            return unavailable(`the product did not answer (${e instanceof Error ? e.name : 'error'})`);
        }
        const body = await res.json().catch(() => undefined);
        if (res.status === 429 && body?.code === 'llm_budget_exceeded') return unavailable(spentBudget(body?.scope), 'llm_budget_exceeded');
        // The product ran Kody and the model (or the run) failed: no verdict on the repository.
        if (res.status === 502 && body?.code === 'llm_unavailable') return unavailable('the model call failed');
        if (!res.ok) return unavailable(`the product answered ${res.status}`);
        // apps/api's TransformInterceptor wraps every success as { statusCode, type, data }.
        const out = body && typeof body === 'object' && 'data' in body && typeof body.data === 'object' ? body.data : body;
        const parsed = RecipeAuthorResponseSchema.safeParse(out);
        if (!parsed.success) return unavailable('the product answered something that is not a recipe author answer');
        return parsed.data;
    }
}
