/**
 * BYOK failure matrix: what each provider's REAL SDK makes of a real failure,
 * and what the stack does with it.
 *
 * ─── WHY ────────────────────────────────────────────────────────────────────
 * The category `classifyLLMError` returns decides, for every provider, whether
 * a failed call is retried, whether it moves to the org's fallback slot, and
 * what the pull-request comment says. `error-classifier.spec.ts` pins the rules
 * on error objects built by hand. That proves the rules, not that the error a
 * provider's SDK actually constructs reaches them in the shape they read: the
 * AI SDK rewrites undici's `TypeError('fetch failed')` into an `APICallError`
 * ("Cannot connect to API: …") and drops the TypeError, each provider parses
 * its own error envelope (or fails to), the agent loop wraps everything that
 * was retried in a `RetryError`. Any of those can hide the field a rule reads.
 *
 * So this drives the same stack as `byok-config-matrix.spec.ts`: a real slot,
 * the real provider module, the real AI SDK, through `LLM.run` (the door every
 * product call uses), with only `globalThis.fetch` stubbed. The primary's host
 * fails the way the network or the vendor fails; the fallback slot (a
 * DIFFERENT provider, on its own host) answers. Each row asserts:
 *   - the category of the error the call surfaces when there is no fallback,
 *   - whether the fallback host was dialled when there is one,
 *   - for the rows that carry `published`, the text the review comment would
 *     post (`buildReviewErrorMessage` over the classification, as
 *     agent-review.stage.ts → finish-comments.stage.ts compose it).
 * Both doors run: the agent loop (SDK retry, 3 retries) and the one-shot text
 * call (SDK retry pinned to 0, one app-level re-issue). They are separate
 * retry owners, so a rule can hold on one and not the other.
 *
 * ─── ADDING A ROW ───────────────────────────────────────────────────────────
 * A provider is one entry in PRIMARIES (a production shape from
 * `byok-prod-shapes.json`, its host, its error bodies). A vendor error is one
 * entry in that provider's failure table, with the outcome it must produce.
 * Transport failures are provider-independent and run for every primary.
 *
 * ─── WHAT THE BODIES ARE ────────────────────────────────────────────────────
 * Each body carries a `source`: `docs` (the vendor's published error
 * reference), `repo` (the wording already pinned in error-classifier.spec.ts
 * from a production incident), or `modeled` (the vendor's envelope with
 * wording reconstructed, not captured). A `modeled` row proves the envelope
 * parses and the rule fires on that wording; it does not prove the vendor
 * still says it.
 *
 * ─── NO NETWORK ─────────────────────────────────────────────────────────────
 * Every request lands on the stub. Vertex is the one provider whose auth step
 * does not use `globalThis.fetch`: google-auth-library's gaxios loads
 * node-fetch with a dynamic `import()`, which Jest refuses (so it fails before
 * any socket). gaxios uses `window.fetch` when a `window` exists, so the
 * Vertex rows install a `window` whose fetch is the stub for the length of the
 * call, and sign the token request with a key generated here.
 */
jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));

import { constants as osConstants } from 'node:os';
import { generateKeyPairSync } from 'node:crypto';

import PROD_SHAPES from './testing/__fixtures__/byok-prod-shapes.json';
import { LLM } from './llm';
import {
    classifyLLMError,
    getClassification,
    LlmErrorCategory,
} from './error-classifier';
import { shouldFailoverToNextModel } from './model-failover';
import { buildReviewErrorMessage } from './review-error-diagnostics';
import type { NormalizedModel } from './byok-config';
import { REGISTRY } from './providers/kernel/registry';
import './providers';

const C = LlmErrorCategory;

// ─── wire constants ─────────────────────────────────────────────────────────

const FALLBACK_HOST = 'fallback.kodus.test';
const GOOGLE_TOKEN_HOST = 'oauth2.googleapis.com';
/** Documentation ranges (RFC 5737 / RFC 3849): addresses nothing dials. */
const IPV4 = '192.0.2.10';
const IPV6 = '2001:db8::10';

// ─── transport failures, in the shape Node 22's undici rejects with ─────────
//
// Captured on Node 22.23 / undici 6.29 against a closed loopback port:
//   fetch('http://127.0.0.1:<closed>')  → TypeError('fetch failed'), cause
//     Error('connect ECONNREFUSED 127.0.0.1:<port>') {errno, code:'ECONNREFUSED',
//     syscall:'connect', address, port}
//   fetch('http://localhost:<closed>')  → same TypeError, cause
//     AggregateError('') {code:'ECONNREFUSED', errors:[::1 refused, 127.0.0.1
//     refused]} — happy eyeballs (autoSelectFamily, on by default) tried both
//     families, and the aggregate's own MESSAGE IS EMPTY.
// DNS and timeout errors are not captured (that needs DNS or a black-holed
// route); they are built from the same constructors' documented output:
// getaddrinfo's `getaddrinfo <CODE> <host>` and undici's ConnectTimeoutError.

type TransportMode =
    | 'refused'
    | 'refused-dual-stack'
    | 'dns-enotfound'
    | 'dns-eai-again'
    | 'connect-timeout'
    | 'etimedout'
    | 'etimedout-dual-stack';

const socketError = (
    code: 'ECONNREFUSED' | 'ETIMEDOUT',
    address: string,
): Error =>
    Object.assign(new Error(`connect ${code} ${address}:443`), {
        errno: -osConstants.errno[code],
        code,
        syscall: 'connect',
        address,
        port: 443,
    });

/** Node's NodeAggregateError: empty message, `code` copied from the first. */
const dualStack = (code: 'ECONNREFUSED' | 'ETIMEDOUT'): Error =>
    Object.assign(
        new AggregateError([socketError(code, IPV6), socketError(code, IPV4)]),
        { code },
    );

const TRANSPORT_CAUSE: Record<TransportMode, (host: string) => Error> = {
    'refused': () => socketError('ECONNREFUSED', IPV4),
    'refused-dual-stack': () => dualStack('ECONNREFUSED'),
    'dns-enotfound': (host) =>
        Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
            errno: -3008,
            code: 'ENOTFOUND',
            syscall: 'getaddrinfo',
            hostname: host,
        }),
    'dns-eai-again': (host) =>
        Object.assign(new Error(`getaddrinfo EAI_AGAIN ${host}`), {
            errno: -3001,
            code: 'EAI_AGAIN',
            syscall: 'getaddrinfo',
            hostname: host,
        }),
    // undici's ConnectTimeoutError (lib/core/errors.js): name + code below,
    // message from onConnectTimeout (lib/core/util.js).
    'connect-timeout': () =>
        Object.assign(
            new Error(
                `Connect Timeout Error (attempted address: ${IPV4}:443, timeout: 10000ms)`,
            ),
            { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' },
        ),
    'etimedout': () => socketError('ETIMEDOUT', IPV4),
    'etimedout-dual-stack': () => dualStack('ETIMEDOUT'),
};

interface Outcome {
    category: LlmErrorCategory;
    /** The fallback slot's host was dialled (and answered). */
    failover: boolean;
}

/**
 * Today's rule for each transport failure, the same for every provider
 * because @ai-sdk/provider-utils wraps them all.
 *
 * The dual-stack rows are the edge. The aggregate carries no message (captured
 * for ECONNREFUSED above), so the SDK's message is "Cannot connect to API: "
 * with nothing after the colon, and the classifier never reads `code`. Only
 * the "cannot connect to api" prefix rule (#1844) makes them TRANSIENT. For
 * ETIMEDOUT that same emptiness hides the word `isAbortOrHardTimeout` looks
 * for, so a dual-stack connect timeout DOES cascade, unlike the single-address
 * one. That shape is built, not captured: through fetch it needs the kernel's
 * connect timeout to fire before undici's own 10s ConnectTimeoutError.
 */
const TRANSPORT_OUTCOME: Record<TransportMode, Outcome> = {
    'refused': { category: C.TRANSIENT, failover: true },
    'refused-dual-stack': { category: C.TRANSIENT, failover: true },
    'dns-enotfound': { category: C.TRANSIENT, failover: true },
    'dns-eai-again': { category: C.TRANSIENT, failover: true },
    'connect-timeout': { category: C.TRANSIENT, failover: false },
    'etimedout': { category: C.TRANSIENT, failover: false },
    'etimedout-dual-stack': { category: C.TRANSIENT, failover: true },
};

// ─── HTTP failures, in each vendor's own envelope ───────────────────────────

type Source = 'docs' | 'repo' | 'modeled';

interface HttpFailure {
    /** What the vendor is saying, in a few words (names the row). */
    mode: string;
    status: number;
    body: unknown;
    headers?: Record<string, string>;
    source: Source;
    expect: Outcome;
    /** Assertions on the text the review comment would post. */
    published?: Published;
    /** Overrides `published` for the agent-loop door, where they differ. */
    publishedInLoop?: Published;
}

interface Published {
    has?: string[];
    hasNot?: string[];
}

const openAiError = (
    message: string,
    type: string,
    code: string | null,
    param: string | null = null,
) => ({ error: { message, type, param, code } });

const anthropicError = (type: string, message: string) => ({
    type: 'error',
    error: { type, message },
});

const googleError = (
    code: number,
    status: string,
    message: string,
    details?: unknown[],
) => ({ error: { code, message, status, ...(details ? { details } : {}) } });

const openRouterError = (code: number, message: string, metadata?: object) => ({
    error: { message, code, ...(metadata ? { metadata } : {}) },
});

const OPENAI_BAD_REQUEST: HttpFailure = {
    mode: 'bad request: invalid_value',
    status: 400,
    source: 'modeled',
    body: openAiError(
        "Invalid value: 'reviewer'. Supported values are: 'system', 'assistant', 'user', 'function', 'tool', and 'developer'.",
        'invalid_request_error',
        'invalid_value',
        'messages[0].role',
    ),
    expect: { category: C.REQUEST_REJECTED, failover: false },
};

const OPENAI_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit per minute (TPM)',
        status: 429,
        source: 'docs',
        body: openAiError(
            'Rate limit reached for gpt-4.1-mini in organization org-Ab12Cd34Ef56Gh78Ij90 on tokens per min (TPM): Limit 200000, Used 199625, Requested 3254. Please try again in 863ms. Visit https://platform.openai.com/account/rate-limits to learn more.',
            'tokens',
            'rate_limit_exceeded',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        // No "quota" in it, so the per-day window reads as a plain rate limit.
        mode: 'rate limit per day (RPD)',
        status: 429,
        source: 'docs',
        body: openAiError(
            'Rate limit reached for gpt-4.1-mini in organization org-Ab12Cd34Ef56Gh78Ij90 on requests per day (RPD): Limit 10000, Used 10000, Requested 1. Please try again in 8.64s. Visit https://platform.openai.com/account/rate-limits to learn more.',
            'requests',
            'rate_limit_exceeded',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: insufficient_quota',
        status: 429,
        source: 'docs',
        body: openAiError(
            'You exceeded your current quota, please check your plan and billing details. For more information on this error, read the docs: https://platform.openai.com/docs/guides/error-codes/api-errors.',
            'insufficient_quota',
            'insufficient_quota',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'auth: invalid_api_key',
        status: 401,
        source: 'docs',
        body: openAiError(
            'Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.',
            'invalid_request_error',
            'invalid_api_key',
        ),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    OPENAI_BAD_REQUEST,
];

/** api-docs.deepseek.com/quick_start/error_codes: 401, 402, 429, no daily. */
const DEEPSEEK_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit',
        status: 429,
        source: 'docs',
        body: openAiError('Rate Limit Reached', 'rate_limit_error', null),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: 402 insufficient balance',
        status: 402,
        source: 'docs',
        body: openAiError(
            'Insufficient Balance',
            'unknown_error',
            'invalid_request_error',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'auth: authentication fails',
        status: 401,
        source: 'docs',
        body: openAiError(
            'Authentication Fails, Your api key: ****abcd is invalid',
            'authentication_error',
            'invalid_request_error',
        ),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'bad request: invalid format',
        status: 400,
        source: 'docs',
        body: openAiError(
            'Invalid format: messages[0] is missing content',
            'invalid_request_error',
            'invalid_request_error',
        ),
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

const MOONSHOT_RPM =
    'Your account org-Ab12Cd34Ef56Gh78<ak-Ab12Cd34Ef56Gh> request reached organization max RPM: 3, please try again after 1 seconds';
const MOONSHOT_SUSPENDED =
    'Your account org-Ab12Cd34Ef56Gh78<ak-Ab12Cd34Ef56Gh> is suspended, please check your plan and billing details';
/** The account and key ids Moonshot echoes never reach the comment. */
const MOONSHOT_IDS = ['org-Ab12Cd34Ef56Gh78', 'ak-Ab12Cd34Ef56Gh'];

/** Moonshot (platform.moonshot.ai error codes); the suspended wording is #2021. */
const MOONSHOT_OPENAI_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit: organization max RPM',
        status: 429,
        source: 'modeled',
        body: {
            error: { message: MOONSHOT_RPM, type: 'rate_limit_reached_error' },
        },
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: account suspended',
        status: 429,
        source: 'repo',
        body: {
            error: {
                message: MOONSHOT_SUSPENDED,
                type: 'exceeded_current_quota_error',
            },
        },
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
        published: { hasNot: MOONSHOT_IDS },
    },
    {
        mode: 'auth: invalid authentication',
        status: 401,
        source: 'modeled',
        body: {
            error: {
                message: 'Invalid Authentication',
                type: 'invalid_authentication_error',
            },
        },
        expect: { category: C.AUTH_INVALID, failover: true },
    },
];

/**
 * Azure OpenAI. Its ordinary token-rate 429 links the quota-increase form
 * (aka.ms/oai/quotaincrease); the classifier reads the provider's words, not
 * its links, so it stays a rate limit (production's only Azure 429 says
 * "exceeded token rate limit", 11-11).
 */
const AZURE_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit per minute (S0 tier)',
        status: 429,
        source: 'modeled',
        headers: { 'retry-after': '6' },
        body: {
            error: {
                code: '429',
                message:
                    'Requests to the ChatCompletions_Create Operation under Azure OpenAI API version 2025-04-01-preview have exceeded token rate limit of your current OpenAI S0 pricing tier. Please retry after 6 seconds. Please go here: https://aka.ms/oai/quotaincrease if you would like to further increase the default rate limit.',
            },
        },
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'auth: invalid subscription key',
        status: 401,
        source: 'docs',
        body: {
            error: {
                code: '401',
                message:
                    'Access denied due to invalid subscription key or wrong API endpoint. Make sure to provide a valid key for an active subscription and use a correct regional API endpoint for your resource.',
            },
        },
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    OPENAI_BAD_REQUEST,
];

/** Novita answers in its own flat envelope, not OpenAI's. */
const NOVITA_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit (flat envelope)',
        status: 429,
        source: 'modeled',
        body: {
            code: 429,
            reason: 'RATE_LIMIT_EXCEEDED',
            message: 'rate limit exceeded, please try again later',
            metadata: {},
        },
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: insufficient balance (flat envelope, 403)',
        status: 403,
        source: 'modeled',
        body: {
            code: 403,
            reason: 'NOT_ENOUGH_BALANCE',
            message: 'Insufficient balance, please recharge your account',
            metadata: {},
        },
        // A 403 is read as an auth refusal first: only a named cap overrides.
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'auth: invalid key (flat envelope)',
        status: 401,
        source: 'modeled',
        body: {
            code: 401,
            reason: 'INVALID_API_KEY',
            message: 'Invalid API key',
            metadata: {},
        },
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'bad request (flat envelope)',
        status: 400,
        source: 'modeled',
        body: {
            code: 400,
            reason: 'INVALID_REQUEST_BODY',
            message: 'messages: field is required',
            metadata: {},
        },
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

const fireworksError = (message: string) => ({
    error: { object: 'error', type: 'invalid_request_error', message },
});

/** Fireworks (the Kodus platform upstream): billing is Kodus's, not the org's. */
const FIREWORKS_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit',
        status: 429,
        source: 'modeled',
        body: fireworksError('Rate limit exceeded, please try again later'),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'auth: invalid key',
        status: 401,
        source: 'modeled',
        body: fireworksError('The API key you provided is invalid.'),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'bad request',
        status: 400,
        source: 'modeled',
        body: fireworksError('messages must be a non-empty array'),
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

const ANTHROPIC_AUTH: HttpFailure = {
    mode: 'auth: invalid x-api-key',
    status: 401,
    source: 'docs',
    body: anthropicError('authentication_error', 'invalid x-api-key'),
    expect: { category: C.AUTH_INVALID, failover: true },
};

const ANTHROPIC_BAD_REQUEST: HttpFailure = {
    mode: 'bad request: invalid_request_error',
    status: 400,
    source: 'modeled',
    body: anthropicError(
        'invalid_request_error',
        'messages: text content blocks must be non-empty',
    ),
    expect: { category: C.REQUEST_REJECTED, failover: false },
};

const ANTHROPIC_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit per minute (ITPM)',
        status: 429,
        source: 'docs',
        body: anthropicError(
            'rate_limit_error',
            'This request would exceed the rate limit for your organization (8a0e6c2b-2b7a-4c6a-9d0e-3f1f4c6b9a11) of 30,000 input tokens per minute. For details, refer to: https://docs.claude.com/en/api/rate-limits. You can see the response headers for current usage. Please reduce the prompt length or the maximum tokens requested, or try again later. You may also contact sales at https://www.anthropic.com/contact-sales to discuss your options for a rate limit increase.',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        // Anthropic has no daily window; its long window is the spend cap,
        // and it answers it with a 400, not a 429.
        mode: 'spend cap until next month (400)',
        status: 400,
        source: 'repo',
        body: anthropicError(
            'invalid_request_error',
            'You have reached your specified API usage limits. You will regain access on 2026-12-01 at 00:00 UTC.',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'billing: credit balance too low (400)',
        status: 400,
        source: 'docs',
        body: anthropicError(
            'invalid_request_error',
            'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    ANTHROPIC_AUTH,
    ANTHROPIC_BAD_REQUEST,
];

/** MiniMax on its Anthropic-compatible endpoint. The 429 wording is pinned
 *  in error-classifier.spec.ts. */
const MINIMAX_FAILURES: HttpFailure[] = [
    {
        mode: 'token plan window (429)',
        status: 429,
        source: 'repo',
        body: anthropicError(
            'rate_limit_error',
            'Token Plan rate limit reached: Upgrade your Token Plan or switch to pay-as-you-go API usage. (2062)',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: insufficient balance (1008)',
        status: 429,
        source: 'modeled',
        body: anthropicError('rate_limit_error', 'insufficient balance (1008)'),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'auth: invalid api key (2049)',
        status: 401,
        source: 'modeled',
        body: anthropicError('authentication_error', 'invalid api key (2049)'),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
];

/** Z.AI / GLM on the Anthropic-compatible endpoint; wording from #2104. */
const ZAI_FAILURES: HttpFailure[] = [
    {
        mode: '5-hour usage window (429)',
        status: 429,
        source: 'repo',
        body: anthropicError(
            '1308',
            'Usage limit reached for 5 hour. Your limit will reset at 2026-11-24 21:00:06',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'weekly/monthly limit exhausted (429)',
        status: 429,
        source: 'repo',
        body: anthropicError(
            '1310',
            'Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-12-01 21:00:06',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'billing: insufficient balance (1113)',
        status: 429,
        source: 'repo',
        body: anthropicError(
            '1113',
            'Insufficient balance or no resource package. Please recharge.',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'auth: no authentication (401)',
        status: 401,
        source: 'modeled',
        body: anthropicError(
            '1001',
            'Authentication parameter not received in Header',
        ),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
];

/** Moonshot's own provider speaks the Anthropic protocol. */
const MOONSHOT_ANTHROPIC_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit: organization max RPM',
        status: 429,
        source: 'modeled',
        body: anthropicError('rate_limit_error', MOONSHOT_RPM),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'billing: account suspended',
        status: 429,
        source: 'repo',
        body: anthropicError('rate_limit_error', MOONSHOT_SUSPENDED),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
        published: { hasNot: MOONSHOT_IDS },
    },
    ANTHROPIC_AUTH,
];

const geminiQuotaDetails = (quotaId: string, retryDelay: string) => [
    {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        'violations': [
            {
                quotaMetric:
                    'generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count',
                quotaId,
                quotaDimensions: {
                    location: 'global',
                    model: 'gemini-2.5-flash',
                },
                quotaValue: '2000000',
            },
        ],
    },
    {
        '@type': 'type.googleapis.com/google.rpc.Help',
        'links': [
            {
                description: 'Learn more about Gemini API quotas',
                url: 'https://ai.google.dev/gemini-api/docs/rate-limits',
            },
        ],
    },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
];

const geminiQuotaMessage = (metric: string, retry: string) =>
    `You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits. To monitor your current usage, head to: https://ai.dev/rate-limit. \n* Quota exceeded for metric: generativelanguage.googleapis.com/${metric}, limit: 2000000, model: gemini-2.5-flash\nPlease retry in ${retry}.`;

const GEMINI_FAILURES: HttpFailure[] = [
    {
        // The whole RESOURCE_EXHAUSTED body. Its quota id names the minute,
        // so this reads as a rate limit with or without the #2130 delay rule.
        mode: 'per-minute input-token quota, full body',
        status: 429,
        source: 'repo',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            geminiQuotaMessage(
                'generate_content_paid_tier_input_token_count',
                '17.320234636s',
            ),
            geminiQuotaDetails(
                'GenerateContentPaidTierInputTokensPerModelPerMinute',
                '17s',
            ),
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
        published: {
            has: ['Provider said: You exceeded your current quota'],
        },
    },
    {
        // #2130: the same 429 without its details. Only the retry delay in
        // the message says it is per-minute.
        mode: 'per-minute input-token quota, message only',
        status: 429,
        source: 'repo',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            geminiQuotaMessage(
                'generate_content_paid_tier_input_token_count',
                '17.320234636s',
            ),
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'daily request quota (free tier), full body',
        status: 429,
        source: 'repo',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            geminiQuotaMessage(
                'generate_content_free_tier_requests',
                '52843.1s',
            ),
            geminiQuotaDetails(
                'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
                '52843s',
            ),
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'daily request quota, message only',
        status: 429,
        source: 'repo',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            geminiQuotaMessage(
                'generate_content_free_tier_requests',
                '52843.1s',
            ),
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'billing quota, no retry delay',
        status: 429,
        source: 'repo',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            'You exceeded your current quota, please check your plan and billing details.',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        // Google answers a wrong key with 400, not 401.
        mode: 'auth: API_KEY_INVALID (400)',
        status: 400,
        source: 'docs',
        body: googleError(
            400,
            'INVALID_ARGUMENT',
            'API key not valid. Please pass a valid API key.',
            [
                {
                    '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                    'reason': 'API_KEY_INVALID',
                    'domain': 'googleapis.com',
                    'metadata': {
                        service: 'generativelanguage.googleapis.com',
                    },
                },
            ],
        ),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'bad request: INVALID_ARGUMENT',
        status: 400,
        source: 'modeled',
        body: googleError(
            400,
            'INVALID_ARGUMENT',
            'Invalid JSON payload received. Unknown name "reviewer" at \'contents[0]\': Cannot find field.',
        ),
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

const VERTEX_UNAUTHENTICATED: HttpFailure = {
    mode: 'auth: UNAUTHENTICATED',
    status: 401,
    source: 'docs',
    body: googleError(
        401,
        'UNAUTHENTICATED',
        'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.',
    ),
    expect: { category: C.AUTH_INVALID, failover: true },
};

const VERTEX_GOOGLE_FAILURES: HttpFailure[] = [
    {
        mode: 'resource exhausted (shared capacity)',
        status: 429,
        source: 'docs',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            'Resource exhausted. Please try again later. Please refer to https://cloud.google.com/vertex-ai/generative-ai/docs/error-code-429 for more details.',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'per-minute project quota',
        status: 429,
        source: 'modeled',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            'Quota exceeded for aiplatform.googleapis.com/generate_content_requests_per_minute_per_project_per_base_model with base model: gemini-3.5-flash. Please submit a quota increase request. https://cloud.google.com/vertex-ai/docs/generative-ai/quotas-genai.',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        // A project without billing is a billing failure Google sends as 403
        // PERMISSION_DENIED: read as a bad credential.
        mode: 'billing disabled (403)',
        status: 403,
        source: 'modeled',
        body: googleError(
            403,
            'PERMISSION_DENIED',
            'This API method requires billing to be enabled. Please enable billing on project #123456789012 by visiting https://console.developers.google.com/billing/enable?project=123456789012 then retry.',
        ),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    VERTEX_UNAUTHENTICATED,
    {
        mode: 'bad request: INVALID_ARGUMENT',
        status: 400,
        source: 'modeled',
        body: googleError(
            400,
            'INVALID_ARGUMENT',
            'Request contains an invalid argument.',
        ),
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

/** Claude on Vertex: Google's envelope for quota and auth, Anthropic's for
 *  the model's own refusals. */
const VERTEX_CLAUDE_FAILURES: HttpFailure[] = [
    {
        mode: 'per-minute input-token quota (Google envelope)',
        status: 429,
        source: 'modeled',
        body: googleError(
            429,
            'RESOURCE_EXHAUSTED',
            'Quota exceeded for aiplatform.googleapis.com/online_prediction_input_tokens_per_minute_per_base_model with base model: anthropic-claude-sonnet-5. Please submit a quota increase request. https://cloud.google.com/vertex-ai/docs/generative-ai/quotas-genai.',
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    VERTEX_UNAUTHENTICATED,
    ANTHROPIC_BAD_REQUEST,
];

/**
 * Bedrock (Converse). Two of its long-window and billing answers carry none
 * of the classifier's vocabulary: a daily token quota reads as a plain rate
 * limit, and a Marketplace payment failure reads as a bad credential.
 */
const BEDROCK_FAILURES: HttpFailure[] = [
    {
        mode: 'ThrottlingException: too many requests',
        status: 429,
        source: 'docs',
        headers: { 'x-amzn-errortype': 'ThrottlingException' },
        body: {
            message: 'Too many requests, please wait before trying again.',
        },
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'ThrottlingException: tokens per day',
        status: 429,
        source: 'modeled',
        headers: { 'x-amzn-errortype': 'ThrottlingException' },
        body: {
            message:
                'Too many tokens per day, please wait before trying again.',
        },
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'AccessDeniedException: invalid payment instrument',
        status: 403,
        source: 'modeled',
        headers: { 'x-amzn-errortype': 'AccessDeniedException' },
        body: {
            message:
                'Model access is denied due to INVALID_PAYMENT_INSTRUMENT:A valid payment instrument must be provided. Your AWS Marketplace subscription for this model cannot be completed at this time. If you recently fixed this issue, try again after 15 minutes.',
        },
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'UnrecognizedClientException: invalid token',
        status: 403,
        source: 'docs',
        headers: { 'x-amzn-errortype': 'UnrecognizedClientException' },
        body: {
            message: 'The security token included in the request is invalid.',
        },
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    {
        mode: 'ValidationException: malformed input',
        status: 400,
        source: 'modeled',
        headers: { 'x-amzn-errortype': 'ValidationException' },
        body: {
            message:
                'Malformed input request: #/messages/0/content: expected minimum item count: 1, found: 0, please reformat your input and try again.',
        },
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
    {
        // A wrong model id is a 400 here, with none of the not-found wording,
        // so it never reaches the fallback the way a 404 would.
        mode: 'ValidationException: invalid model identifier',
        status: 400,
        source: 'docs',
        headers: { 'x-amzn-errortype': 'ValidationException' },
        body: { message: 'The provided model identifier is invalid.' },
        expect: { category: C.REQUEST_REJECTED, failover: false },
    },
];

/** Upstream text an OpenRouter row must never publish. */
const ECHOED_PROMPT =
    'const kodusFixtureSecret = loadVault("prod-db-password")';
const ECHOED_KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

const OPENROUTER_FAILURES: HttpFailure[] = [
    {
        mode: 'rate limit: free-models-per-min',
        status: 429,
        source: 'docs',
        body: openRouterError(
            429,
            'Rate limit exceeded: free-models-per-min. ',
            {
                headers: {
                    'X-RateLimit-Limit': '20',
                    'X-RateLimit-Remaining': '0',
                    'X-RateLimit-Reset': '1764000000000',
                },
            },
        ),
        expect: { category: C.RATE_LIMIT, failover: true },
    },
    {
        mode: 'rate limit: free-models-per-day',
        status: 429,
        source: 'docs',
        body: openRouterError(
            429,
            'Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'billing: 402 more credits',
        status: 402,
        source: 'docs',
        body: openRouterError(
            402,
            'This request requires more credits, or fewer max_tokens. You requested up to 65536 tokens, but can only afford 12345. To increase, visit https://openrouter.ai/settings/credits and upgrade to a paid account',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'key limit exceeded (403)',
        status: 403,
        source: 'repo',
        body: openRouterError(
            403,
            'Key limit exceeded (monthly limit). Manage it using https://openrouter.ai/workspaces/default/keys/<key> $10.02 of $10.00 used; resets 2026-12-01T00:00:00.000Z.',
        ),
        expect: { category: C.QUOTA_EXCEEDED, failover: true },
    },
    {
        mode: 'auth: user not found',
        status: 401,
        source: 'docs',
        body: openRouterError(401, 'User not found.'),
        expect: { category: C.AUTH_INVALID, failover: true },
    },
    // ─── "Provider returned error": the upstream's answer is in metadata.raw
    {
        mode: 'upstream 400, raw JSON with a message (#1871)',
        status: 400,
        source: 'repo',
        body: openRouterError(400, 'Provider returned error', {
            raw: JSON.stringify({
                error: {
                    message: 'max_tokens must be at most 8192 for this model',
                    type: 'invalid_request_error',
                },
            }),
            provider_name: 'Chutes',
        }),
        expect: { category: C.REQUEST_REJECTED, failover: false },
        published: {
            has: ['Chutes: max_tokens must be at most 8192 for this model'],
        },
    },
    {
        mode: 'upstream 400, raw plain sentence (#1871)',
        status: 400,
        source: 'modeled',
        body: openRouterError(400, 'Provider returned error', {
            raw: 'Invalid request: tool_choice auto is not supported for this model',
            provider_name: 'Fireworks',
        }),
        expect: { category: C.REQUEST_REJECTED, failover: false },
        published: {
            has: [
                'Fireworks: Invalid request: tool_choice auto is not supported for this model',
            ],
        },
    },
    {
        // A validation error that echoes the input it rejected: no labelled
        // message, so nothing of `raw` is published.
        mode: 'upstream 400, raw echoes the prompt (#1871)',
        status: 400,
        source: 'modeled',
        body: openRouterError(400, 'Provider returned error', {
            raw: JSON.stringify({
                detail: [
                    {
                        type: 'string_too_long',
                        loc: ['body', 'messages', 0, 'content'],
                        msg: 'String should have at most 100 characters',
                        input: ECHOED_PROMPT,
                    },
                ],
            }),
            provider_name: 'DeepInfra',
        }),
        expect: { category: C.REQUEST_REJECTED, failover: false },
        published: { hasNot: [ECHOED_PROMPT, 'prod-db-password'] },
    },
    {
        // The upstream's own message names the key it was sent: classified
        // by that wording (AUTH_INVALID), the key itself redacted.
        mode: 'upstream 400, raw names the API key (#1871)',
        status: 400,
        source: 'modeled',
        body: openRouterError(400, 'Provider returned error', {
            raw: JSON.stringify({
                error: {
                    message: `Incorrect API key provided: ${ECHOED_KEY}. You can find your API key at https://platform.openai.com/account/api-keys.`,
                    type: 'invalid_request_error',
                    code: 'invalid_api_key',
                },
            }),
            provider_name: 'OpenAI',
        }),
        expect: { category: C.AUTH_INVALID, failover: true },
        published: {
            has: ['OpenAI: Incorrect API key provided: [redacted]'],
            hasNot: [ECHOED_KEY, '0123456789abcdef'],
        },
    },
    {
        // OpenRouter's moderation refusal: a 403, so it reads as a bad key
        // and cascades. `flagged_input` (the prompt) is never published.
        mode: 'moderation 403 with flagged_input',
        status: 403,
        source: 'docs',
        body: {
            error: {
                code: 403,
                message:
                    'openai/gpt-4o requires moderation on OpenAI. Your input was flagged for "harassment". No credits were charged.',
                metadata: {
                    reasons: ['harassment'],
                    flagged_input: ECHOED_PROMPT,
                    provider_name: 'OpenAI',
                    model_slug: 'openai/gpt-4o',
                },
            },
        },
        expect: { category: C.AUTH_INVALID, failover: true },
        published: {
            has: ['Your input was flagged for "harassment"'],
            hasNot: [ECHOED_PROMPT, 'prod-db-password'],
        },
    },
    {
        // Retried by both doors before it surfaces.
        mode: 'upstream 429, raw sentence',
        status: 429,
        source: 'docs',
        body: openRouterError(429, 'Provider returned error', {
            raw: 'deepseek/deepseek-chat-v3.1:free is temporarily rate-limited upstream. Please retry shortly, or add your own key to accumulate your rate limits: https://openrouter.ai/settings/integrations',
            provider_name: 'Chutes',
        }),
        expect: { category: C.RATE_LIMIT, failover: true },
        published: {
            has: [
                'Chutes: deepseek/deepseek-chat-v3.1:free is temporarily rate-limited upstream',
            ],
        },
    },
];

// ─── primaries: one production slot per provider (and brand) ────────────────

type Shape = Record<string, unknown> & { provider: string; model: string };

/** A shape as STORED in production, minus the org count. Throws if the
 *  fixture no longer holds it, so a refresh cannot silently shrink a row. */
function prodShape(match: Partial<Shape>): Shape {
    const found = (PROD_SHAPES as Shape[]).find((s) =>
        Object.entries(match).every(([k, v]) => s[k] === v),
    );
    if (!found) {
        throw new Error(
            `byok-prod-shapes.json has no shape ${JSON.stringify(match)}`,
        );
    }
    const { orgs: _orgs, ...slot } = found;
    return slot as Shape;
}

/** A service account whose key is generated here: the token request is
 *  signed for real and answered by the stub. */
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const VERTEX_SA_B64 = Buffer.from(
    JSON.stringify({
        type: 'service_account',
        project_id: 'kodus-failure-matrix',
        private_key_id: 'failure-matrix',
        private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        client_email: 'matrix@kodus-failure-matrix.iam.gserviceaccount.com',
        client_id: '1',
        token_uri: `https://${GOOGLE_TOKEN_HOST}/token`,
    }),
).toString('base64');

interface Primary {
    label: string;
    slot: Shape;
    /** Every primary request must land here. */
    host: string;
    failures: HttpFailure[];
}

const PRIMARIES: Primary[] = [
    {
        label: 'openai',
        slot: prodShape({ provider: 'openai', model: 'gpt-4.1-mini' }),
        host: 'api.openai.com',
        failures: OPENAI_FAILURES,
    },
    {
        label: 'openai_compatible (DeepSeek)',
        slot: prodShape({
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com',
        }),
        host: 'api.deepseek.com',
        failures: DEEPSEEK_FAILURES,
    },
    {
        label: 'openai_compatible (Kimi on Moonshot)',
        slot: prodShape({
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/v1',
        }),
        host: 'api.moonshot.ai',
        failures: MOONSHOT_OPENAI_FAILURES,
    },
    {
        label: 'anthropic',
        slot: prodShape({
            provider: 'anthropic',
            model: 'claude-haiku-4-5-20251001',
        }),
        host: 'api.anthropic.com',
        failures: ANTHROPIC_FAILURES,
    },
    {
        label: 'anthropic_compatible (MiniMax)',
        slot: prodShape({
            provider: 'anthropic_compatible',
            model: 'MiniMax-M3',
            baseURL: 'https://api.minimax.io/anthropic',
        }),
        host: 'api.minimax.io',
        failures: MINIMAX_FAILURES,
    },
    {
        label: 'anthropic_compatible (GLM on Z.AI)',
        slot: prodShape({
            provider: 'anthropic_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/anthropic',
        }),
        host: 'api.z.ai',
        failures: ZAI_FAILURES,
    },
    {
        label: 'google_gemini',
        slot: prodShape({
            provider: 'google_gemini',
            model: 'gemini-2.5-flash',
        }),
        host: 'generativelanguage.googleapis.com',
        failures: GEMINI_FAILURES,
    },
    {
        label: 'google_vertex (Gemini)',
        slot: prodShape({
            provider: 'google_vertex',
            model: 'gemini-3.5-flash',
        }),
        host: 'aiplatform.googleapis.com',
        failures: VERTEX_GOOGLE_FAILURES,
    },
    {
        label: 'google_vertex (Claude)',
        slot: prodShape({
            provider: 'google_vertex',
            model: 'claude-sonnet-5',
        }),
        host: 'aiplatform.googleapis.com',
        failures: VERTEX_CLAUDE_FAILURES,
    },
    {
        label: 'open_router',
        slot: prodShape({
            provider: 'open_router',
            model: '~deepseek/deepseek-flash-latest',
            reasoningEffort: 'high',
        }),
        host: 'openrouter.ai',
        failures: OPENROUTER_FAILURES,
    },
    {
        label: 'amazon_bedrock',
        slot: prodShape({
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-haiku-4-5-20251001-v1:0',
        }),
        host: 'bedrock-runtime.us-west-2.amazonaws.com',
        failures: BEDROCK_FAILURES,
    },
    {
        label: 'novita',
        slot: prodShape({
            provider: 'novita',
            model: 'deepseek/deepseek-v4-pro',
        }),
        host: 'api.novita.ai',
        failures: NOVITA_FAILURES,
    },
    {
        label: 'moonshot',
        slot: prodShape({ provider: 'moonshot', model: 'kimi-k2.6' }),
        host: 'api.moonshot.ai',
        failures: MOONSHOT_ANTHROPIC_FAILURES,
    },
    {
        label: 'zai',
        slot: prodShape({
            provider: 'zai',
            model: 'GLM-5.2',
            maxConcurrentRequests: 2,
        }),
        host: 'api.z.ai',
        failures: ZAI_FAILURES,
    },
    {
        label: 'kodus (Fireworks)',
        slot: prodShape({
            provider: 'kodus',
            model: 'fireworks/accounts/fireworks/models/deepseek-v4p1-flash',
        }),
        host: 'api.fireworks.ai',
        failures: FIREWORKS_FAILURES,
    },
    {
        // No production slot uses the `azure` id, so this one shape is the
        // config matrix's.
        label: 'azure',
        slot: {
            provider: 'azure',
            model: 'o3-mini',
            baseURL: 'https://r.openai.azure.com/openai',
        },
        host: 'r.openai.azure.com',
        failures: AZURE_FAILURES,
    },
];

/** Registered ids the matrix does not drive, with the reason. */
const NOT_DRIVEN: Record<string, string> = {};

// ─── the harness ────────────────────────────────────────────────────────────

type Door = 'loop' | 'text';
const DOORS: Door[] = ['loop', 'text'];

type PrimaryFailure =
    | { kind: 'transport'; mode: TransportMode }
    | { kind: 'http'; failure: HttpFailure };

const json = (
    body: unknown,
    status = 200,
    headers: Record<string, string> = {},
) =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json', ...headers },
    });

/** What the fallback answers, in the protocol its URL speaks. */
function fallbackAnswer(url: string): Response {
    if (/\/messages\b/.test(url)) {
        return json({
            id: 'fb',
            type: 'message',
            role: 'assistant',
            model: 'fallback-model',
            content: [{ type: 'text', text: 'fallback ok' }],
            stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        });
    }
    return json({
        id: 'fb',
        object: 'chat.completion',
        created: 0,
        model: 'fallback-model',
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content: 'fallback ok' },
                finish_reason: 'stop',
            },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
}

/** A fallback on a DIFFERENT provider, on a host of its own. */
function fallbackFor(primary: Shape): Omit<NormalizedModel, 'fallback'> {
    const onOpenAiWire =
        /^(openai|openai_compatible|open_router|novita|kodus|azure|google_gemini)$/.test(
            primary.provider,
        );
    return (
        onOpenAiWire
            ? {
                  provider: 'anthropic_compatible',
                  // A known id, so the SDK does not warn about an unknown one.
                  model: 'claude-haiku-4-5',
                  apiKey: 'fallback-key',
                  baseURL: `https://${FALLBACK_HOST}`,
              }
            : {
                  provider: 'openai_compatible',
                  model: 'fallback-model',
                  apiKey: 'fallback-key',
                  baseURL: `https://${FALLBACK_HOST}/v1`,
              }
    ) as Omit<NormalizedModel, 'fallback'>;
}

function urlOf(input: unknown): string {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    return String((input as { url?: string })?.url ?? input);
}

/** Stub the network: the primary fails as `failure` says, the fallback and
 *  Google's token endpoint answer. Returns the hosts dialled, in order. */
function installWire(failure: PrimaryFailure): string[] {
    const hosts: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
        const url = urlOf(input);
        const host = new URL(url).hostname;
        hosts.push(host);
        if (host === FALLBACK_HOST) return fallbackAnswer(url);
        if (host === GOOGLE_TOKEN_HOST) {
            return json({
                access_token: 'ya29.failure-matrix',
                expires_in: 3600,
                token_type: 'Bearer',
            });
        }
        if (failure.kind === 'transport') {
            // Exactly what undici rejects with: the socket error rides as cause.
            throw new TypeError('fetch failed', {
                cause: TRANSPORT_CAUSE[failure.mode](host),
            });
        }
        const { status, body, headers } = failure.failure;
        return json(body, status, headers);
    }) as typeof fetch;
    return hosts;
}

async function callThroughDoor(door: Door, slot: NormalizedModel) {
    // Vertex's auth step dials through gaxios, which uses `window.fetch` when
    // there is a window; without one it imports node-fetch, which Jest
    // refuses. Route it to the stub for the length of the call only.
    const isVertex = slot.provider === 'google_vertex';
    const scope = globalThis as { window?: unknown };
    if (isVertex) {
        scope.window = {
            fetch: (...args: Parameters<typeof fetch>) =>
                globalThis.fetch(...args),
        };
    }
    try {
        return door === 'loop'
            ? await LLM.run({
                  byokConfig: slot,
                  messages: [{ role: 'user', content: 'ping' }],
                  loop: { tools: {}, maxSteps: 1 },
                  runName: 'byok-failure-matrix',
              })
            : await LLM.run({
                  byokConfig: slot,
                  user: 'ping',
                  runName: 'byok-failure-matrix',
              });
    } finally {
        if (isVertex) delete scope.window;
    }
}

function slotFor(primary: Primary): NormalizedModel {
    return {
        apiKey: primary.slot.provider === 'google_vertex' ? VERTEX_SA_B64 : 'k',
        ...primary.slot,
    } as unknown as NormalizedModel;
}

/** The comment a failed review posts, composed as the pipeline does:
 *  agent-review.stage.ts stores the classification on `lastReviewError`,
 *  finish-comments.stage.ts renders it with `buildReviewErrorMessage`. */
function publishedFor(err: unknown, slot: NormalizedModel) {
    const classification =
        getClassification(err) ?? classifyLLMError(err, slot.provider);
    return {
        classification,
        text: buildReviewErrorMessage({
            friendlyMessage: classification.friendlyMessage,
            provider: classification.provider ?? slot.provider,
            model: slot.model,
            httpStatus: classification.httpStatus,
            providerMessage: classification.providerMessage,
        }),
    };
}

async function runCase(
    primary: Primary,
    door: Door,
    failure: PrimaryFailure,
    expected: Outcome,
    published?: Published,
) {
    const solo = slotFor(primary);
    const offHost = (hosts: string[]) =>
        hosts.filter((h) => h !== GOOGLE_TOKEN_HOST && h !== primary.host);

    // 1. No fallback: the error the call surfaces, and what it publishes.
    let hosts = installWire(failure);
    const err = await callThroughDoor(door, solo).then(
        (value) => {
            throw new Error(`the primary answered: ${JSON.stringify(value)}`);
        },
        (e: unknown) => e,
    );
    expect(hosts).toContain(primary.host);
    expect(offHost(hosts)).toEqual([]);
    const { classification, text } = publishedFor(err, solo);
    expect({
        category: classification.category,
        cascades: shouldFailoverToNextModel(err),
    }).toEqual({ category: expected.category, cascades: expected.failover });
    for (const has of published?.has ?? []) expect(text).toContain(has);
    for (const hasNot of published?.hasNot ?? []) {
        expect(text).not.toContain(hasNot);
    }

    // 2. With a fallback on another provider: is it dialled, and does it serve?
    hosts = installWire(failure);
    const withFallback = {
        ...solo,
        fallback: fallbackFor(primary.slot),
    } as NormalizedModel;
    const outcome = await callThroughDoor(door, withFallback).then(
        () => 'served by fallback',
        (e: unknown) => `failed: ${(e as Error)?.message}`,
    );
    expect({
        fallbackDialled: hosts.includes(FALLBACK_HOST),
        outcome,
    }).toEqual({
        fallbackDialled: expected.failover,
        outcome: expected.failover
            ? 'served by fallback'
            : expect.stringMatching(/^failed: /),
    });
    expect(offHost(hosts).filter((h) => h !== FALLBACK_HOST)).toEqual([]);
}

// ─── the matrix ─────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;
const realSetTimeout = globalThis.setTimeout;
const PLATFORM_KEY = 'API_KODUS_PROVIDER_FIREWORKS_API_KEY';
const previousPlatformKey = process.env[PLATFORM_KEY];

beforeAll(() => {
    // The `kodus` slot reads Kodus's platform key from env at build time.
    process.env[PLATFORM_KEY] ??= 'k';
    // The SDK's compatibility warnings are noise here, not findings.
    (globalThis as { AI_SDK_LOG_WARNINGS?: boolean }).AI_SDK_LOG_WARNINGS =
        false;
    // Retry backoff (SDK: 2s, 4s, 8s; one-shot: up to 4s) is real waiting,
    // not behavior: collapse every wait under 30s. Hard timeouts are minutes
    // and keep their length.
    globalThis.setTimeout = ((
        fn: (...a: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
    ) =>
        realSetTimeout(
            fn,
            ms !== undefined && ms <= 30_000 ? 0 : ms,
            ...args,
        )) as typeof setTimeout;
});

afterAll(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.fetch = realFetch;
    if (previousPlatformKey === undefined) delete process.env[PLATFORM_KEY];
    else process.env[PLATFORM_KEY] = previousPlatformKey;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

describe('BYOK failure matrix: every registered provider is driven', () => {
    it('each provider id in the registry has a primary row (or a reason it has none)', () => {
        const driven = new Set(PRIMARIES.map((p) => p.slot.provider));
        const missing = REGISTRY.ids().filter(
            (id) => !driven.has(id) && !(id in NOT_DRIVEN),
        );
        expect(missing).toEqual([]);
    });
});

const TRANSPORT_ROWS = PRIMARIES.flatMap((primary) =>
    DOORS.flatMap((door) =>
        (Object.keys(TRANSPORT_OUTCOME) as TransportMode[]).map(
            (mode) =>
                [
                    primary.label,
                    primary.slot.model,
                    mode,
                    door,
                    primary,
                ] as const,
        ),
    ),
);

describe('transport failures (fetch rejects before any status)', () => {
    it.each(TRANSPORT_ROWS)(
        '%s · %s · %s · %s door',
        async (_label, _model, mode, door, primary) => {
            await runCase(
                primary,
                door,
                { kind: 'transport', mode },
                TRANSPORT_OUTCOME[mode],
            );
        },
    );
});

const HTTP_ROWS = PRIMARIES.flatMap((primary) =>
    DOORS.flatMap((door) =>
        primary.failures.map(
            (failure) =>
                [
                    primary.label,
                    primary.slot.model,
                    `HTTP ${failure.status} ${failure.mode} [${failure.source}]`,
                    door,
                    primary,
                    failure,
                ] as const,
        ),
    ),
);

describe("HTTP failures (the vendor's own error body)", () => {
    it.each(HTTP_ROWS)(
        '%s · %s · %s · %s door',
        async (_label, _model, _mode, door, primary, failure) => {
            await runCase(
                primary,
                door,
                { kind: 'http', failure },
                failure.expect,
                door === 'loop'
                    ? (failure.publishedInLoop ?? failure.published)
                    : failure.published,
            );
        },
    );
});
