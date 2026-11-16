import { RECIPE_AUTHOR_PATH, type RecipeAuthorLast, type RecipeAuthorResponse, RecipeAuthorResponseSchema } from '@libs/runtime/contracts/recipe-author';

import { Agent, fetch as undiciFetch } from 'undici';

import type { SecretOpener } from '../secrets/sealed-tokens';
import type { FetchLike } from './http-llm-gateway';
import { failureName, postToProduct, PRODUCT_CONNECT_RETRY_MS, unwrapProductBody } from './product-call';

/**
 * What the setup's recipe step gets back: Kody's answer, or why there was
 * none. `unavailable` is not Kody's verdict (the product, the budget or the
 * model did not answer): the setup goes on as it would without Kody.
 */
export type RecipeAuthorOutcome = RecipeAuthorResponse | { status: 'unavailable'; code: 'llm_budget_exceeded' | 'llm_unavailable'; message: string };

/** The product's limit on one Kody run is ten minutes (RECIPE_AUTHOR_TIMEOUT_MS); the worker waits a minute more for the answer to arrive. */
export const RECIPE_AUTHOR_CLIENT_TIMEOUT_MS = 11 * 60_000;

/**
 * Pauses before sending again a request the product never received (or, with
 * an `attempt`, one whose answer may have been lost): about two minutes in
 * all, what an API restart takes.
 */
export const RECIPE_AUTHOR_CONNECT_RETRY_MS = PRODUCT_CONNECT_RETRY_MS;

/** The pause before asking again about an attempt the product is still writing (409 author_in_progress). */
export const RECIPE_AUTHOR_IN_PROGRESS_POLL_MS = 15_000;

/** The budget a 429 names, in the setup's words; a setup counts no pull request, so any other scope reads as its own. */
const spentBudget = (scope: unknown) => (scope === 'org_day' ? "the organization's LLM budget for today is spent" : "the setup's LLM budget is spent");

export interface RecipeAuthorRequestInput {
    organizationId: string;
    /** The setup's token for the product, sealed to `setupKey` (as the learn loop's). */
    llmToken: string;
    setupKey: string;
    sha: string;
    /**
     * Which of the setup's calls to Kody this is: `author-0` for its first
     * recipe, `repair-<n>` for each repair. The product keeps one outcome per
     * setup and attempt and answers a repeat with it, so a call whose answer
     * was lost is asked again instead of running Kody twice.
     */
    attempt?: string;
    /** The authored recipe the environment's last setup booted with, at another commit, and how its boot failed if it did. */
    last?: RecipeAuthorLast;
    /** `last` booted but predates a revision of the author's instructions it must get: Kody writes it again (recipe-author-version.ts). */
    reauthor?: { from: number; to: number };
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
    private readonly timeoutMs: number;
    private dispatcher?: Agent;

    constructor(
        baseUrl: string,
        private readonly opts: {
            secrets: SecretOpener;
            fetch?: FetchLike;
            timeoutMs?: number;
            connectRetryDelaysMs?: readonly number[];
            inProgressPollMs?: number;
            sleep?: (ms: number) => Promise<void>;
            now?: () => number;
        },
    ) {
        this.url = `${baseUrl.replace(/\/+$/, '')}/${RECIPE_AUTHOR_PATH}`;
        this.timeoutMs = opts.timeoutMs ?? RECIPE_AUTHOR_CLIENT_TIMEOUT_MS;
    }

    /**
     * Kody answers once its run ends, up to ten minutes later. Node's fetch
     * gives up on a response whose headers take 300 s (undici's default
     * headersTimeout) with a bare TypeError, before the product's own limit
     * ends: the worker then lost answers the product was about to send.
     * The dispatcher waits as long as the abort signal does.
     */
    private defaultFetch(): FetchLike {
        this.dispatcher ??= new Agent({ headersTimeout: this.timeoutMs, bodyTimeout: this.timeoutMs });
        const dispatcher = this.dispatcher;
        return ((url: string, init: Parameters<FetchLike>[1]) =>
            undiciFetch(url, { ...(init as object), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as FetchLike;
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
        const doFetch = this.opts.fetch ?? this.defaultFetch();
        const now = this.opts.now ?? Date.now;
        const sleep = this.opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        // Every send, pause and wait of this call ends within the author timeout, counted from here.
        const deadline = now() + this.timeoutMs;
        // The product restarting (a deploy) refuses the connection for a minute or two: that request never
        // reached Kody, so it is sent again after a pause instead of ending the setup with no recipe. With an
        // `attempt`, the product answers a repeat with what it stored: a request whose answer may have been
        // lost (a reset, a timeout, a 502/503 while it restarts) is sent again too, and Kody does not run twice.
        const send = (body: RecipeAuthorBody) =>
            postToProduct(doFetch, this.url, token, body, {
                timeoutMs: this.timeoutMs,
                connectRetryDelaysMs: this.opts.connectRetryDelaysMs ?? RECIPE_AUTHOR_CONNECT_RETRY_MS,
                sleep,
                now,
                deadline,
                resend: body.attempt ? 'deduplicated' : 'never_reached',
            });
        const poll = this.opts.inProgressPollMs ?? RECIPE_AUTHOR_IN_PROGRESS_POLL_MS;
        /** One body, asked again while the product says the same attempt is still being written. */
        const reaching = async (body: RecipeAuthorBody) => {
            let answer = await send(body);
            while (inProgress(answer) && now() + poll < deadline) {
                await sleep(poll);
                answer = await send(body);
            }
            return answer;
        };
        // A product older than this worker refuses the fields it does not know with a 400 (nothing ran):
        // asked again without `attempt`, then without `last` (Kody writes from the repository alone). A
        // product with no `attempt` does not deduplicate: there, an answer lost on the way is not asked
        // again, and a repeat it ignored the field on may run Kody twice.
        const bodies = ladder({ sha: req.sha, ...(req.attempt ? { attempt: req.attempt } : {}), ...(req.last ? { last: req.last } : {}), ...(req.last && req.reauthor ? { reauthor: req.reauthor } : {}) });
        let answer: Awaited<ReturnType<typeof reaching>>;
        try {
            answer = await reaching(bodies[0]);
            for (const next of bodies.slice(1)) {
                if (answer.res.status !== 400) break;
                answer = await reaching(next);
            }
        } catch (e) {
            return unavailable(`the product did not answer (${failureName(e)})`);
        }
        if (inProgress(answer)) return unavailable('Kody was still writing this recipe when the wait ran out');
        const { res, body } = answer;
        if (res.status === 429 && body?.code === 'llm_budget_exceeded') return unavailable(spentBudget(body?.scope), 'llm_budget_exceeded');
        // The product ran Kody and the model (or the run) failed: no verdict on the repository.
        if (res.status === 502 && body?.code === 'llm_unavailable') return unavailable('the model call failed');
        if (!res.ok) return unavailable(`the product answered ${res.status}`);
        const parsed = RecipeAuthorResponseSchema.safeParse(unwrapProductBody(body));
        if (!parsed.success) return unavailable('the product answered something that is not a recipe author answer');
        return parsed.data;
    }
}

type RecipeAuthorBody = { sha: string; attempt?: string; last?: RecipeAuthorLast; reauthor?: { from: number; to: number } };

/** The product is still writing this attempt's recipe (a concurrent call with the same attempt). */
const inProgress = (answer: { res: { status: number }; body: any }) => answer.res.status === 409 && answer.body?.code === 'author_in_progress';

/**
 * The request, then what an older product takes after each 400: without
 * `reauthor` (it answers the last recipe as is, `reused`), without `attempt`,
 * then without `last` either.
 */
const ladder = (body: RecipeAuthorBody): RecipeAuthorBody[] => {
    const out = [body];
    if (body.reauthor) out.push({ sha: body.sha, ...(body.attempt ? { attempt: body.attempt } : {}), ...(body.last ? { last: body.last } : {}) });
    if (body.attempt) out.push({ sha: body.sha, ...(body.last ? { last: body.last } : {}) });
    if (body.last) out.push({ sha: body.sha });
    return out;
};
