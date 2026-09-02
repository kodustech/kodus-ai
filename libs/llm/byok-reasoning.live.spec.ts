/**
 * BYOK reasoning LIVE contract — "does the shape we emit still WORK upstream?"
 *
 * ─── WHY THIS EXISTS, SEPARATELY FROM byok-config-matrix.spec.ts ────────────
 * The offline matrix proves that a stored config produces the request body we
 * intend. It cannot prove that body is still CORRECT, because that fact lives on
 * the provider's side and changes on the provider's timeline. The regression we
 * keep hitting is exactly that: a model changes how it is configured, our
 * request quietly stops meaning what it meant, and nobody finds out until a
 * customer's reviews get worse.
 *
 * So this tier issues a REAL, minimal call per brand, through the production
 * path: `LLM.run` → slot resolution → failover → executor → the vendor.
 *
 * ─── IT ASSERTS THE EFFECT, NOT JUST THE ABSENCE OF AN ERROR ────────────────
 * The dangerous drift is SILENT. If a vendor renames `thinking` or stops
 * honouring `reasoning_effort`, the request still returns 200 — it just stops
 * reasoning, and the only visible symptom is worse review quality weeks later.
 * A test that only asserts "no 400" would stay green through exactly the
 * failure it was written to catch. So for every brand we ask for reasoning, we
 * assert the response actually BILLED reasoning tokens.
 *
 * ─── CREDENTIALS ───────────────────────────────────────────────────────────
 * One CI-only secret, `BYOK_LIVE_KEYS`, holding a JSON map of brand → key:
 *
 *     {"deepseek":"sk-…","moonshot":"sk-…","zai":"…","open_router":"sk-or-…"}
 *
 * Deliberately ONE secret rather than a new `process.env.*` per brand: these are
 * test credentials, not product configuration, and adding a brand should not
 * grow the product's env surface. Brands fall back to env names that ALREADY
 * EXIST as repo secrets, checked with `gh secret list` rather than assumed:
 *
 *     BYOK_ANTHROPIC_API_KEY   -> the four Claude generations
 *     BYOK_MOONSHOT_API_KEY    -> moonshot, moonshot_code, anthropic_compatible (k3)
 *     BYOK_ZHIPU_API_KEY       -> zai (Zhipu is Z.ai, the GLM vendor)
 *     BYOK_GOOGLE_API_KEY      -> google_gemini
 *     BYOK_OPENAI_API_KEY      -> openai
 *
 * Ten of the twenty rows are runnable on those alone, with no new credential.
 * The fallbacks used to name `API_MOONSHOT_API_KEY`, `API_OPEN_AI_API_KEY` and
 * friends — the PRODUCT's env names, none of which exist as repo secrets. The
 * workflow passed them faithfully and every one resolved to an empty string, so
 * the fallback path had never once produced a key. Those names are kept as
 * SECOND fallbacks, for a local run where they may be set.
 *
 * A case with no key SKIPS — it never fails. A run with partial credentials
 * reports partial coverage, so contributors and forks see green, not a false red.
 *
 * ─── THE SECRET, COMPLETE ──────────────────────────────────────────────────
 * Copy this into the repo secret `BYOK_LIVE_KEYS` and delete the brands you have
 * no key for — a missing brand SKIPS, it never fails, so a partial secret is a
 * valid secret and reports partial coverage.
 *
 *     {
 *       "deepseek":             "sk-…",
 *       "moonshot":             "sk-…",
 *       "moonshot_code":        "sk-…",
 *       "anthropic_compatible": "sk-…",
 *       "zai":                  "…",
 *       "minimax":              "…",
 *       "minimax_m3":           "…",
 *       "minimaxi":             "…",
 *       "open_router":          "sk-or-…",
 *       "openai":               "sk-…",
 *       "anthropic":            "sk-ant-…",
 *       "anthropic-legacy":     "sk-ant-…",
 *       "anthropic-modern":     "sk-ant-…",
 *       "anthropic-off-modern": "sk-ant-…",
 *       "google_gemini":        "…",
 *       "google_vertex":        "<service-account JSON>"  (defaults to the
 *                                 existing VERTEX_SA_JSON secret — no entry needed),
 *       "amazon_bedrock":       { "apiKey": "<bearer>", "awsRegion": "us-east-1" },
 *       "bedrock_grok":         { "apiKey": "<bearer>", "awsRegion": "us-east-1" },
 *       "azure":                { "apiKey": "…",
 *                                 "baseURL": "https://<resource>.openai.azure.com/openai",
 *                                 "model": "<your o-series deployment name>" }
 *     }
 *
 * A value still holding a placeholder ('…' or angle brackets) reads as ABSENT,
 * so a half-filled copy of the template SKIPS the rest instead of failing on
 * auth — see `isUnfilledCredential`. The coverage report names those brands on
 * their own line so "left blank" and "sent nothing" stay distinguishable.
 *
 * The SIX Anthropic entries can hold the SAME key — they are six generations of
 * Claude, not six accounts, and they are separate brands only so a key you do
 * have does not skip the generations you want tested. All of them already fall
 * back to `BYOK_ANTHROPIC_API_KEY`, so none needs an entry unless you want a
 * different key or a different MODEL:
 *
 *     "anthropic-fable": { "apiKey": "sk-ant-…", "model": "claude-fable-5-1" }
 *
 * — which is how a newer generation gets tested without a code change.
 *
 * ─── EVERY FIELD CAN COME FROM THE JSON ────────────────────────────────────
 * A brand's entry may be the bare key, or an object carrying the key plus ANY
 * slot field. The object's fields are spread OVER the row below, so the secret
 * always wins:
 *
 *     {
 *       "deepseek": "sk-…",
 *       "zai":      { "apiKey": "…", "model": "glm-5.3" },
 *       "minimaxi": { "apiKey": "…", "baseURL": "https://api.minimaxi.com/v1" },
 *       "azure":    { "apiKey": "…", "model": "o3-mini",
 *                     "baseURL": "https://r.openai.azure.com/openai" },
 *       "bedrock_grok": { "apiKey": "…", "awsRegion": "us-west-2" }
 *     }
 *
 * So the baseURLs written into the rows are DEFAULTS, not fixtures: they are the
 * vendors' public endpoints, kept in the file because reading a row should tell
 * you which vendor it talks to without opening a secret. Anything account-shaped
 * — Azure's resource endpoint, an AWS region, a model your key actually has
 * access to — belongs in the JSON and overrides the default without a code
 * change. Adding a brand is one row plus one JSON key; changing where an
 * existing brand points is JSON alone.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));


import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { LLM } from './llm';
import { parseSaCredentials } from './model-builders';
import type { NormalizedModel } from './byok-config';

/**
 * Is this value still the TEMPLATE rather than a credential? The example file
 * ships placeholders (`sk-…`, `<bearer token>`) and filling in only the brands
 * you have keys for is the documented way to use it — so a slot left as shipped
 * has to read as ABSENT.
 *
 * Otherwise it reads as present: the row runs, the vendor answers 401, and the
 * weekly job goes red for a reason that has nothing to do with the code under
 * test — the one failure mode that teaches people to ignore this job.
 */
export function isUnfilledCredential(value: unknown): boolean {
    if (typeof value !== 'string') {
        return false;
    }
    const v = value.trim();
    // `includes`, not `startsWith`: the template's endpoint placeholder buries
    // its angle brackets mid-string (`https://<your-resource>.openai.azure.com`).
    // No real key, host, region or model id contains one.
    return v === '' || v.includes('…') || v.includes('<');
}

/**
 * Parse the secret, dropping the fields that are still placeholders. Stripping
 * per FIELD, not per brand, is what makes the Azure row honest: an entry that
 * carries a real `apiKey` next to the template's `<your-resource>` endpoint is
 * not a usable Azure config, and the row's own `baseURL` gate now sees that.
 */
export function liveKeys(raw: string | undefined): {
    keys: Record<string, LiveEntry>;
    /** Brands present in the secret whose every field is still a placeholder. */
    unfilled: string[];
} {
    let parsed: Record<string, LiveEntry>;
    try {
        parsed = JSON.parse(raw || '{}');
    } catch {
        throw new Error(
            'BYOK_LIVE_KEYS is set but is not valid JSON — expected {"brand":"key"}.',
        );
    }
    const keys: Record<string, LiveEntry> = {};
    const unfilled: string[] = [];
    for (const [brand, entry] of Object.entries(parsed)) {
        // `_readme` and friends are notes to the human filling this in.
        if (brand.startsWith('_')) {
            continue;
        }
        if (typeof entry === 'string') {
            if (isUnfilledCredential(entry)) {
                unfilled.push(brand);
            } else {
                keys[brand] = entry;
            }
            continue;
        }
        if (!entry || typeof entry !== 'object') {
            continue;
        }
        const kept = Object.fromEntries(
            Object.entries(entry).filter(([, v]) => !isUnfilledCredential(v)),
        );
        if (Object.keys(kept).length > 0) {
            keys[brand] = kept;
        }
        // Unfilled is judged on the CREDENTIAL, not on whether anything at all
        // survived: Bedrock's real `us-east-1` next to a placeholder key is
        // still a brand you meant to enable and didn't. Saying "region kept" and
        // calling it filled would be the least useful true statement available.
        if (!kept.apiKey) {
            unfilled.push(brand);
        }
    }
    return { keys, unfilled };
}

const { keys: KEYS, unfilled: UNFILLED } = liveKeys(process.env.BYOK_LIVE_KEYS);

/**
 * A brand's entry is either the key itself, or an object carrying the key plus
 * the slot fields that brand needs beyond one — Azure cannot be reached without
 * its resource endpoint and deployment name, and Bedrock wants a region.
 *
 *   { "deepseek": "sk-…",
 *     "azure": { "apiKey": "…", "baseURL": "https://r.openai.azure.com/openai",
 *                "model": "o3-mini" } }
 *
 * Kept inside the ONE secret on purpose. The alternative was a new
 * `process.env.*` per brand, and five of the six names that would have taken do
 * not exist anywhere in this repo — inventing env vars to make a test runnable
 * is how a config surface grows without anyone deciding to grow it.
 */
type LiveEntry = string | { apiKey?: string; [slotField: string]: unknown };

/**
 * Brand → the repo secrets that ALREADY hold its credential under a name that
 * predates this file.
 *
 * ONE table instead of a fallback list written out at each row. The per-row
 * lists drifted twice in a single day: the job passed `BYOK_GOOGLE_API_KEY`
 * while the Gemini row read two names that are repo secrets nowhere, and an
 * earlier commit had to delete four `API_*` names that resolved to nothing on
 * every run. Both are the same defect — the credential a brand uses was stated
 * in two places, and only one of them was ever checked.
 *
 * Renaming these to a single convention was the other option and it is closed:
 * all seven are load-bearing in other workflows (`BYOK_OPENAI_API_KEY` alone is
 * read by six), so the legacy names stay and this table is where the mapping
 * lives. Any brand NOT listed derives `BYOK_<BRAND>_API_KEY`, so a new brand
 * needs no entry unless its secret is already called something else.
 *
 * The invariants at the bottom of this file check the table against the
 * workflow in BOTH directions, which is what stops the drift from coming back.
 */
const REPO_SECRET: Record<string, string[]> = {
    anthropic: ['BYOK_ANTHROPIC_API_KEY'],
    moonshot: ['BYOK_MOONSHOT_API_KEY'],
    zai: ['BYOK_ZHIPU_API_KEY'],
    google_gemini: ['BYOK_GOOGLE_API_KEY', 'GEMINI_API_KEY'],
    openai: ['BYOK_OPENAI_API_KEY'],
    google_vertex: ['VERTEX_SA_JSON'],
};

/**
 * Brand → the brand whose credential it falls back to.
 *
 * Six of these are Claude GENERATIONS, not accounts: one key tests all six
 * request shapes. The rest are a model reached over a second transport
 * (`moonshot_code`, `open_router_glm`) — same vendor, same key, different wire.
 * A brand may still carry its own entry in the secret to override.
 */
const BORROWS_FROM: Record<string, string> = {
    'anthropic-legacy': 'anthropic',
    'anthropic-modern': 'anthropic',
    'anthropic-off-modern': 'anthropic',
    'anthropic-opus-5': 'anthropic',
    'anthropic-fable': 'anthropic',
    anthropic_compatible: 'moonshot',
    moonshot_code: 'moonshot',
    open_router_glm: 'open_router',
    open_router_qwen: 'open_router',
    open_router_nemotron: 'open_router',
    open_router_mimo: 'open_router',
    open_router_grok: 'open_router',
    openai_compatible_gpt5: 'openai',
    openai_compatible_claude: 'anthropic',
    minimax_m3: 'minimax',
    // Same provider, same `awsBearerToken`, same account — only the model id
    // and the region differ. It needs its own entry only when Grok is enabled
    // in a different account or region than the Claude row's.
    bedrock_grok: 'amazon_bedrock',
};

/**
 * The credential for a brand: its own entry in the secret, then the repo secret
 * that holds it, then the same two questions asked of the brand it borrows from.
 *
 * Rows do not name environment variables. That is the whole point — a row that
 * states its own env names is a second source for a fact this table already
 * owns, and the two cannot be kept in step by remembering.
 */
const key = (brand: string): string | undefined => {
    const seen = new Set<string>();
    let b: string | undefined = brand;
    while (b && !seen.has(b)) {
        seen.add(b);
        const entry = KEYS[b] as LiveEntry | undefined;
        const fromSecret = typeof entry === 'string' ? entry : entry?.apiKey;
        if (fromSecret) {
            return fromSecret as string;
        }
        const names = REPO_SECRET[b] ?? [`BYOK_${b.toUpperCase()}_API_KEY`];
        const fromEnv = names.map((n) => process.env[n]).find(Boolean);
        if (fromEnv) {
            return fromEnv;
        }
        b = BORROWS_FROM[b];
    }
    return undefined;
};

/** The extra slot fields an object-form entry carries (everything but apiKey). */
const slotExtras = (brand: string): Record<string, unknown> => {
    const entry = KEYS[brand] as LiveEntry | undefined;
    if (!entry || typeof entry === 'string') return {};
    const { apiKey: _ignored, ...rest } = entry;
    return rest;
};

/**
 * One row per brand whose reasoning shape we make a claim about. `reasons: true`
 * means "this call must come back having spent reasoning tokens" — the silent-
 * drift detector. Add a brand by adding a row.
 *
 * EFFORT IS `low` UNLESS THE LEVEL IS THE SUBJECT
 * `maxOutputTokens` caps the worst case; the effort decides what is actually
 * burned, and `high` authorises a 40,000-token budget to answer one word. Nearly
 * every row here is testing the request SHAPE, which `low` exercises identically
 * at a fraction of the spend. Three rows keep a higher level because the level
 * IS what they check: deepseek's low/high/max mapping, GLM folding low/medium
 * into high, and the Gemini budget landing inside a model ceiling.
 */
/**
 * The credential a row will run on, or undefined when it must skip. Every
 * consumer asks THIS — the row itself no longer carries the answer, so a row
 * and its credential cannot disagree.
 */
const credentialFor = (row: { brand: string; requires?: () => boolean }) =>
    row.requires && !row.requires() ? undefined : key(row.brand);

/**
 * Auth fields a brand may carry INSTEAD of a single key.
 *
 * Bedrock is the only one today: `bedrockModelFromCredentials` takes a bearer
 * token OR a SigV4 pair, and an entry that supplies the pair has a credential
 * even though `apiKey` is empty. Without this the row skipped while holding
 * exactly what it needed — the same "green means nothing" the tier exists to
 * prevent, one level down.
 */
const MULTI_FIELD_AUTH = [
    'awsBearerToken',
    'awsAccessKeyId',
    'awsSecretAccessKey',
    'awsSessionToken',
];

/**
 * The auth fields a brand ends up with, following the same borrow chain a key
 * follows — `bedrock_grok` is the `amazon_bedrock` account with a different
 * model id, so it inherits the credential whichever FORM that credential takes.
 * Only auth is inherited: a borrowed `baseURL` or `model` would silently point
 * one row at another's endpoint.
 */
const authFieldsFor = (brand: string): Record<string, unknown> => {
    const seen = new Set<string>();
    let b: string | undefined = brand;
    while (b && !seen.has(b)) {
        seen.add(b);
        const extras = slotExtras(b);
        const auth = Object.fromEntries(
            MULTI_FIELD_AUTH.filter((f) => !!extras[f]).map((f) => [
                f,
                extras[f],
            ]),
        );
        if (Object.keys(auth).length > 0) {
            return auth;
        }
        b = BORROWS_FROM[b];
    }
    return {};
};

/** Does this row have SOMETHING to authenticate with? */
const canRun = (row: { brand: string; requires?: () => boolean }): boolean => {
    if (row.requires && !row.requires()) {
        return false;
    }
    return !!key(row.brand) || Object.keys(authFieldsFor(row.brand)).length > 0;
};

/**
 * The secret names the CI job actually sets for this spec — read out of the
 * workflow, from the env block of the one step that runs this file. Two control
 * names are dropped: the harness reads them itself, no brand does.
 */
function secretsPassedByCi(): string[] {
    const workflow = readFileSync(
        join(__dirname, '..', '..', '.github', 'workflows', 'contract-tests.yml'),
        'utf8',
    );
    // The RUN line, not the first mention — the job's comments name the spec
    // several times above its own env block.
    const runAt = workflow.indexOf(
        'run: pnpm exec jest --config jest.config.ts libs/llm/byok-reasoning.live.spec.ts',
    );
    if (runAt < 0) {
        throw new Error(
            'byok-live: could not find the step that runs this spec in contract-tests.yml',
        );
    }
    const liveEnv = workflow.slice(workflow.lastIndexOf('env:', runAt), runAt);
    const names = [
        ...liveEnv.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s*\$\{\{\s*secrets\./gm),
    ]
        .map((m) => m[1])
        .filter((n) => n !== 'BYOK_LIVE_KEYS' && n !== 'BYOK_LIVE_EVENT');
    if (names.length === 0) {
        // A regex that matched nothing would make every check below vacuous.
        throw new Error('byok-live: parsed no secrets out of the job env block');
    }
    return names;
}

const LIVE = [
    {
        brand: 'deepseek',
        why: 'sends `thinking` AND `reasoning_effort` together, on the low/high/max scale',
        slot: {
            provider: 'openai_compatible',
            model: 'deepseek-v4-flash',
            baseURL: 'https://api.deepseek.com',
            reasoningEffort: 'high',
        },
        reasons: true,
    },
    {
        brand: 'moonshot',
        why: 'sends `thinking` ALONE — Moonshot 400s if an effort rides along',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.6',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'zai',
        why: 'sends `thinking` + `reasoning_effort`, and keeps temperature',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.2',
            baseURL: 'https://api.z.ai/api/paas/v4',
            reasoningEffort: 'medium',
            temperature: 0,
        },
        reasons: true,
    },
    {
        brand: 'google_gemini',
        why: 'thinkingBudget must land INSIDE the model ceiling (2.5-flash tops out at 24,576)',
        // The clamped ceiling IS what this row tests, so the cap clears it
        // rather than lowering the effort and testing nothing.
        maxOutputTokens: 26_000,
        slot: {
            provider: 'google_gemini',
            model: 'gemini-2.5-flash',
            reasoningEffort: 'high',
        },
        reasons: true,
    },
    {
        brand: 'open_router',
        why: 'reasoning.effort and the provider pin must survive the namespace boundary',
        slot: {
            provider: 'open_router',
            model: 'deepseek/deepseek-v4-flash',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'openai',
        why: 'native reasoning effort on the Responses API',
        slot: {
            provider: 'openai',
            model: 'gpt-5.4',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'google_vertex',
        why: 'the ONLY provider the offline matrix cannot exercise — its build needs a real service-account JSON, so this tier is its only coverage. Production slots: ZERO today (all 42 Google-model shapes run over AI Studio, OpenRouter or a proxy), and the row stays anyway: Vertex is a supported provider whose transport code can rot unwatched precisely BECAUSE nobody is exercising it, and AI Studio does not cover it — different endpoint, different auth, different SDK package',
        slot: {
            provider: 'google_vertex',
            model: 'gemini-3.7-flash',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    // ── Anthropic is THREE generations with mutually exclusive request shapes,
    // and one row only ever covered the middle one. Every model below mirrors a
    // real production shape.
    //
    // WHAT THESE PROVE, precisely — checked on the wire before claiming it:
    // the AI SDK strips `temperature` by itself whenever thinking is ON, for
    // every Anthropic model. So while thinking is enabled these rows prove the
    // THINKING SHAPE only, not the temperature policy. Temperature becomes ours
    // to get right exactly when thinking is OFF — the SDK forwards it then, and
    // on the 4.7+/5 line it is a 400. That is the last row.
    {
        brand: 'anthropic',
        why: 'adaptive-4-6: thinking {type:adaptive} + output_config.effort',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'anthropic-legacy',
        why: 'legacy (3.x-4.5): budgetTokens is REQUIRED and `adaptive` is rejected — the opposite shape from the row above, on the same provider and the same key',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-5-20250929',
            reasoningEffort: 'low',
        },
        // `low` emits budget_tokens 5_000; the cap has to clear it.
        maxOutputTokens: 6_144,
        reasons: true,
    },
    {
        brand: 'anthropic-modern',
        why: 'THE 4.6->4.7 boundary: 4.7+ REJECTS budgetTokens outright, so sending the legacy shape here is a hard 400. Three production shapes run claude-opus-4-7',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'anthropic-off-modern',
        why: 'the row that carries the most: reasoning OFF on a 4.7+/5 model WITH a stored temperature. Two things can only be checked here — the disable must be said OUT LOUD (an adaptive Claude thinks unless told not to, so silence means the user who picked Off keeps paying), and temperature must be WITHHELD by our policy, because with thinking off the SDK forwards it and this line 400s on it. `claude-sonnet-5` with a stored temperature is a real production shape',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-5',
            reasoningEffort: 'none',
            temperature: 0.3,
        },
        reasons: false as const,
    },
    {
        brand: 'anthropic-opus-5',
        why: 'Opus 5 shares the adaptive shape with the 4.7 row above, and shares nothing else: it is the most expensive model any customer runs, so a request shape that regresses here costs the most per review. `low`, not high — the SHAPE is the subject and one word needs no budget',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'anthropic-fable',
        why: 'the ALWAYS-THINKING generation, and the only branch of the Anthropic table with no live coverage at all. Fable/Mythos reject `thinking:{type:disabled}` with a 400, so for them "off" has to mean OMITTING the field — the exact opposite of the claude-sonnet-5 row above, which must say the disable out loud. Effort is `none` on purpose: that is the branch under test, and asserting `reasons: true` under it is the whole point — we send no disable and the model thinks anyway. If we ever start sending one, this row 400s instead of quietly costing a customer their reviews',
        slot: {
            provider: 'anthropic',
            model: 'claude-fable-5',
            reasoningEffort: 'none',
        },
        // A newer Fable (5.1 and on) needs no new row: put
        // `{"apiKey":"…","model":"claude-fable-5-1"}` in the secret and the
        // spread overrides the model here. The id is NOT guessed in code —
        // `claude-fable-5` is one the SDK declares, and inventing an id that may
        // not exist yet would fail this row for the wrong reason.
        reasons: true,
    },
    {
        brand: 'anthropic_compatible',
        why: 'the SAME Kimi over the ANTHROPIC protocol, where the emitted shape differs from the openai_compatible row above — and k3 is always-thinking, so the rule is "omit the disable, pin temperature to 1" rather than "send one"',
        slot: {
            provider: 'anthropic_compatible',
            model: 'k3',
            baseURL: 'https://api.kimi.com/coding',
            // `low`, not `high`, ON PURPOSE: what this row tests is the SHAPE
            // this transport emits, and `high` would authorise a 40,000-token
            // thinking budget for a prompt asking for one word. The effort VALUE
            // is tested where it is the subject (deepseek's low/high/max
            // mapping, GLM's medium fold).
            reasoningEffort: 'low',
        },
        maxOutputTokens: 6_144,
        reasons: true,
    },
    // NOT covered, deliberately: `novita` (3 production shapes). Verified against
    // novita.ai/docs — the vendor exposes no reasoning parameter at all, so there
    // is no shape of ours that could drift. Its DeepSeek models reason by
    // default; the level simply is not expressible on that endpoint.

    // ── mappings added after this tier was written, and unmonitored until now ──
    // Each is a shape we now emit in production and nothing live was checking.
    {
        brand: 'minimax',
        why: 'effort-only: MiniMax M2 takes `reasoning_effort` and has NO thinking toggle — sending one would invent a field it does not have (18 production slots)',
        slot: {
            provider: 'openai_compatible',
            model: 'MiniMax-M2',
            baseURL: 'https://api.minimax.io/v1',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'amazon_bedrock',
        why: 'Claude on Converse takes the adaptive shape inside additionalModelRequestFields, and this transport cannot express an explicit disable (5 production slots)',
        slot: {
            provider: 'amazon_bedrock',
            model: 'anthropic.claude-sonnet-4-6',
            // API_AWS_REGION is the one name here that already exists in
            // this repo's env schema; a per-run override rides in the secret.
            awsRegion: process.env.API_AWS_REGION || 'us-east-1',
            reasoningEffort: 'low',
        },
        // Bedrock authenticates with a bearer token, not `apiKey`; the slot
        // field is filled from the same value below.
        credentialField: 'awsBearerToken' as const,
        reasons: true,
    },
    {
        brand: 'azure',
        why: 'an o-series deployment takes OpenAI reasoning.effort under the azure namespace — the module had no reasoning() at all until recently',
        slot: {
            provider: 'azure',
            // Both are deployment-specific and come from the secret's object
            // form; without an endpoint there is nothing to call, so the row
            // skips rather than failing on an empty URL.
            model: 'o3-mini',
            baseURL: '',
            reasoningEffort: 'low',
        },
        // No endpoint, nothing to call: a deployment URL is not optional on
        // Azure the way a baseURL is elsewhere, so the row skips rather than
        // failing against an empty URL.
        requires: () => !!slotExtras('azure').baseURL,
        reasons: true,
    },

    // ── gaps found by weighing the rows against what production actually runs.
    // Each is a (provider + family) combination with real slots behind it and no
    // live row, which is how a transport-specific rule goes unchecked. ────────
    {
        brand: 'open_router_glm',
        why: 'OpenRouter is 67 production shapes and was represented by ONE family. GLM is its largest (17 shapes) and behaves nothing like DeepSeek there: the aggregator normalises `reasoning:{effort}` for every upstream, so what this row checks is whether OpenRouter still translates it for a Z.ai model rather than passing our field through to an upstream that wants `thinking`',
        slot: {
            provider: 'open_router',
            model: 'z-ai/glm-5.2',
            reasoningEffort: 'medium',
        },
        reasons: true,
    },
    {
        brand: 'openai_compatible_gpt5',
        why: 'twelve production shapes name a GPT-5 behind an OpenAI-protocol proxy, and the temperature rule for exactly this case was CHANGED today: the reasoner check now runs before the transport branch, so the field is withheld where it used to be sent. Nothing live was checking it. The slot carries a temperature the runtime must drop — if it ever reaches the wire, this is where that shows',
        slot: {
            provider: 'openai_compatible',
            model: 'gpt-5.4',
            baseURL: 'https://api.openai.com/v1',
            reasoningEffort: 'medium',
            temperature: 0.2,
        },
        // Same vendor, same key as the native `openai` row — what differs is the
        // provider id we resolve through, which is the whole point.
        reasons: true,
    },
    {
        brand: 'openai_compatible_claude',
        // The endpoint is Anthropic's OWN OpenAI-compatibility layer, so this
        // row needs no proxy of anyone's and no credential of its own — the
        // vendor documents this exact base URL with an Anthropic key:
        //   base_url="https://api.anthropic.com/v1/"  # the Claude API endpoint
        //   api_key=os.environ.get("ANTHROPIC_API_KEY")
        //   https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk
        //
        // `reasons: false` is not a lowered bar, it is the FINDING. Seven
        // production slots run a Claude behind an OpenAI-protocol endpoint with
        // an effort configured, and the wire harness shows the body we build is
        //   {"model":"claude-sonnet-4-6","messages":[…]}
        // — the effort reaches nothing. Two independent reasons, both from the
        // vendor's table: `reasoning_effort` is listed "Ignored" on this layer,
        // and thinking is asked for as `thinking: {type, budget_tokens}`, which
        // our openai_compatible path does not emit for a Claude id.
        //
        // So this row pins the CURRENT behaviour and goes red the day it
        // changes — whether because we start sending `thinking` (the fix) or
        // because a model begins thinking on its own (adaptive is on by default
        // on the 5 line, which would make a `reasons: true` here pass for a
        // reason that has nothing to do with what we sent).
        why: 'seven shapes run a REAL Claude over an OpenAI-protocol endpoint with a configured effort that reaches NO parameter — proven on the wire, and confirmed by the vendor listing `reasoning_effort` as Ignored on this layer. Pins the gap so the fix is visible when it lands',
        slot: {
            provider: 'openai_compatible',
            model: 'claude-sonnet-4-6',
            baseURL: 'https://api.anthropic.com/v1',
            reasoningEffort: 'medium',
        },
        reasons: false,
    },

    // ── families with real production weight and NO row at all. The code makes
    // no per-model claim about any of them — no trait entry, no reasoning
    // schema — so what these check is the TRANSPORT: that the body we build for
    // an id we know nothing about is accepted rather than rejected. A 400
    // because we sent a field an upstream refuses is a production outage for
    // that org, and it is invisible to every offline test, which only ever
    // proves what we SEND.
    //
    // `reasons: false` on these is an assertion, not a shrug: it says no
    // reasoning tokens are billed. If a vendor starts thinking on its own the
    // row goes red, and the bill moves before anyone reads a changelog.
    //
    // All four ride the OpenRouter key already in the template — one credential
    // covers thirteen production slots across four families that had none.
    {
        brand: 'open_router_qwen',
        // `reasons: false`: no thinking budget to clear, so a word is enough.
        maxOutputTokens: 512,
        why: 'Qwen is 8 production slots and no row. A coder model with no trait entry: the check is that OpenRouter accepts our reasoning field for a non-thinking upstream instead of passing it through to a 400',
        slot: {
            provider: 'open_router',
            model: 'qwen/qwen3-coder',
            reasoningEffort: 'low',
        },
        reasons: false,
    },
    {
        brand: 'open_router_nemotron',
        // `reasons: false`: no thinking budget to clear, so a word is enough.
        maxOutputTokens: 512,
        why: 'Nemotron is 10 slots, 7 of them through OpenRouter, and NVIDIA ids carry suffixes (:free, -reasoning) that decide behaviour while our code reads none of them',
        slot: {
            provider: 'open_router',
            model: 'nvidia/nemotron-3-ultra-550b-a55b',
            reasoningEffort: 'low',
        },
        reasons: false,
    },
    {
        brand: 'open_router_mimo',
        // `reasons: false`: no thinking budget to clear, so a word is enough.
        maxOutputTokens: 512,
        why: 'MiMo is 7 slots across two Xiaomi PoPs and OpenRouter, with no trait entry anywhere',
        slot: {
            provider: 'open_router',
            model: 'xiaomi/mimo-v2-pro',
            reasoningEffort: 'low',
        },
        reasons: false,
    },
    {
        brand: 'open_router_grok',
        // `reasons: false`: no thinking budget to clear, so a word is enough.
        maxOutputTokens: 512,
        why: 'the OTHER Grok slot. `bedrock_grok` pins the Converse transport; this pins the aggregator one, where the same model is reached by a path that normalises reasoning for every upstream',
        slot: {
            provider: 'open_router',
            model: 'x-ai/grok-4.3',
            temperature: 0,
            reasoningEffort: 'low',
        },
        reasons: false,
    },

    // ── the biggest UNCOVERED hosts, by production weight. Each is an
    // OpenAI-protocol endpoint serving a model that reasons natively, so
    // `reasons: true` here is the sharp question: if it comes back false, the
    // host ate our reasoning field and every org on it is paying for a
    // configured effort that does nothing.
    {
        brand: 'fireworks',
        // Enough for a low-effort thought plus a visible token, not the default.
        maxOutputTokens: 2048,
        why: 'api.fireworks.ai is the largest uncovered host (11 slots) and the only one whose ids are DEEP PATHS — `accounts/fireworks/models/…`. That shape already broke cost lookup once; here it must also survive as a model id, and the effort must reach a DeepSeek that reasons natively',
        slot: {
            provider: 'openai_compatible',
            model: 'accounts/fireworks/models/deepseek-v4-flash-0731',
            baseURL: 'https://api.fireworks.ai/inference/v1',
            temperature: 0,
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'ollama_cloud',
        // Enough for a low-effort thought plus a visible token, not the default.
        maxOutputTokens: 2048,
        why: 'ollama.com/v1 is 8 slots and the only host reached with a `:cloud` / `:free` id SUFFIX, which our model matching does not read — a GLM that reasons natively is the way to see whether the suffix costs us the reasoning',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.2:cloud',
            baseURL: 'https://ollama.com/v1',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'xiaomi',
        // `reasons: false`: no thinking budget to clear, so a word is enough.
        maxOutputTokens: 512,
        why: 'the NATIVE MiMo surface (4 slots across a Singapore and an Amsterdam PoP), as opposed to the OpenRouter one above. No trait entry, so this pins that the request is accepted',
        slot: {
            provider: 'openai_compatible',
            model: 'mimo-v2.5-pro',
            baseURL: 'https://token-plan-sgp.xiaomimimo.com/v1',
            reasoningEffort: 'low',
        },
        reasons: false,
    },

    // ── the audit's open questions: cases where the DOCS and our code disagree,
    // or where no readable doc exists at all. Offline tests cannot settle any of
    // these — they prove what we SEND, and the question is what the vendor
    // ACCEPTS. Each one is a claim currently resting on inference. ──────────
    {
        brand: 'minimax_m3',
        why: 'M3 is a different model from M2 on the same platform: platform.minimax.io says thinking is OFF by default and enabled "with adaptive", while we send thinking:{type:enabled,budget_tokens}. Nothing says `enabled` is refused, so it was not changed on a guess — this row is what turns the guess into an answer (3 production slots)',
        slot: {
            provider: 'anthropic_compatible',
            model: 'MiniMax-M3',
            baseURL: 'https://api.minimax.io/anthropic',
            // `low` for the same reason as the k3 row: the SHAPE is the subject,
            // and a high effort would authorise a 40,000-token budget to say one
            // word.
            reasoningEffort: 'low',
        },
        maxOutputTokens: 6_144,
        // Falls back to the `minimax` entry: same platform (api.minimax.io) and
        // the same account — this row differs by MODEL and PROTOCOL, not by
        // credential. Asking for the key twice would be friction that buys
        // nothing, and a separate entry only exists so a key scoped to one model
        // can still be given on its own.
        //
        // No ENV fallback, though: the point of the single secret is that adding
        // a brand does not grow the product's env surface, and no MiniMax name
        // exists in this repo's schema to fall back to.
        reasons: true,
    },
    {
        brand: 'minimaxi',
        why: 'MiniMax runs TWO platforms and production uses both. api.minimaxi.com is the one this table cites for `reasoning_effort` and the one whose docs render client-side, so it could not be read — the only way to check it is to call it (2 production slots)',
        slot: {
            provider: 'openai_compatible',
            model: 'MiniMax-M2.5',
            baseURL: 'https://api.minimaxi.com/v1',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'moonshot_code',
        why: 'k2.7-code is the pair to the k2.6 row and differs on BOTH facts we changed: thinking cannot be disabled, and platform.kimi.ai documents its temperature as not modifiable. The slot deliberately carries a temperature the runtime must DROP — if it ever reaches the wire this row is where that shows',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'low',
            temperature: 0.2,
        },
        reasons: true,
    },
    {
        brand: 'bedrock_grok',
        why: 'the one case the audit refused to guess. Four Bedrock slots configure an effort that reaches no parameter, because AWS documents Grok reasoning:{effort} for its Responses API and shows none in its Converse example — inventing an additionalModelRequestFields entry risks a ValidationException on every review. `reasons: false` asserts the CURRENT behaviour, so this row goes red the day the transport starts carrying it, either because AWS documented it or because we did',
        slot: {
            provider: 'amazon_bedrock',
            model: 'global.xai.grok-4.6',
            awsRegion: process.env.API_AWS_REGION || 'us-east-1',
            reasoningEffort: 'low',
        },
        credentialField: 'awsBearerToken' as const,
        // Grok reasons intrinsically, so tokens may well be spent — what this
        // row cannot claim is that OUR effort caused it. Asserted as "we send
        // nothing", which is checkable, rather than "reasoning happened", which
        // would be true either way and prove nothing.
        reasons: false,
    },
];

/** Reasoning tokens, wherever the SDK put them (ai@7 nests, ai@6 was flat). */
function reasoningTokens(usage: any): number {
    return (
        usage?.outputTokenDetails?.reasoningTokens ??
        usage?.reasoningTokens ??
        0
    );
}

describe('BYOK reasoning — LIVE provider contract', () => {
    const configured = LIVE.filter((c) => canRun(c));

    // Runs OFFLINE and with no credentials, on purpose: it is arithmetic about
    // what WOULD be sent, and the budget must be guarded on the PR that changes
    // it rather than a week later on someone's bill.
    it('the whole run stays inside its token budget', async () => {
        // The declared `maxOutputTokens` is NOT the number that reaches the
        // wire. For a budget-shape model the Anthropic SDK ADDS the thinking
        // budget on top — a row asking for 6,144 goes out at 11,144 — so the
        // ceiling has to be read from the request, not from the row.
        const real = globalThis.fetch;
        const ANTHROPIC_OK = {
            id: 'x', type: 'message', role: 'assistant', model: 'x',
            content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn',
            usage: { input_tokens: 1, output_tokens: 1 },
        };
        const GEMINI_OK = {
            candidates: [{ content: { parts: [{ text: 'ok' }], role: 'model' }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        const OPENAI_OK = {
            id: 'x', object: 'chat.completion', created: 0, model: 'x',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };

        let total = 0;
        const perRow: Array<[string, number]> = [];
        try {
            for (const c of LIVE) {
                let sent: any;
                globalThis.fetch = (async (input: any, init: any) => {
                    const url = typeof input === 'string' ? input : String(input?.url ?? input);
                    try {
                        sent = init?.body ? JSON.parse(String(init.body)) : undefined;
                    } catch {
                        sent = undefined;
                    }
                    const canned = /generateContent/i.test(url)
                        ? GEMINI_OK
                        : /\/messages\b/i.test(url)
                          ? ANTHROPIC_OK
                          : OPENAI_OK;
                    return new Response(JSON.stringify(canned), {
                        status: 200,
                        headers: { 'content-type': 'application/json' },
                    });
                }) as typeof fetch;

                try {
                    await LLM.run({
                        byokConfig: {
                            ...c.slot,
                            apiKey: 'budget-probe',
                            ...((c as any).credentialField
                                ? { [(c as any).credentialField]: 'budget-probe' }
                                : {}),
                        } as unknown as NormalizedModel,
                        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
                        loop: { tools: {}, maxSteps: 1 },
                        runName: 'byok-live-budget',
                        maxOutputTokens: (c as any).maxOutputTokens ?? 4_096,
                    });
                } catch {
                    // A canned answer the provider's parser rejects is fine —
                    // the REQUEST is what is being measured.
                }
                const cap =
                    sent?.max_tokens ??
                    sent?.generationConfig?.maxOutputTokens ??
                    sent?.max_output_tokens ??
                    sent?.inferenceConfig?.maxTokens ??
                    0;
                total += cap;
                perRow.push([c.brand, cap]);
            }
        } finally {
            globalThis.fetch = real;
        }

        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] output ceiling ${total.toLocaleString()} tokens across ` +
                `${LIVE.length} rows:\n` +
                perRow.map(([b, n]) => `  ${String(n).padStart(7)}  ${b}`).join('\n'),
        );

        // A weekly job nobody watches is exactly where a runaway cost hides. The
        // number is small on purpose — the subject under test is the request
        // SHAPE, and a one-word answer needs no room. Raising this is allowed and
        // has to be deliberate: it means a row now authorises real spend.
        expect(total).toBeLessThanOrEqual(150_000);
        // ...and no single row may hold most of the budget on its own.
        for (const [brand, cap] of perRow) {
            expect([brand, cap]).toEqual([brand, expect.any(Number)]);
            expect(cap).toBeLessThanOrEqual(30_000);
        }
        // The probe must actually have measured something — a stub that captured
        // nothing would sum to zero and pass.
        expect(total).toBeGreaterThan(50_000);
    }, 120_000);

    /**
     * The shipped template must cover NOTHING. It is the file people copy, and
     * every value in it is a placeholder — if any of them read as a credential,
     * a half-filled copy would run that row against a vendor with the literal
     * string `sk-…` and fail on auth, which looks like a broken test rather
     * than an unfilled field. Reading the real example file (not a copy of its
     * strings) is the point: a new placeholder STYLE added to the template
     * fails here until the guard learns to recognise it.
     */
    it('treats every value in the shipped template as absent', () => {
        const template = readFileSync(
            join(__dirname, 'testing', 'byok-live-keys.example.json'),
            'utf8',
        );
        const { keys, unfilled } = liveKeys(template);

        // Not "the map is empty" — stripping is per FIELD, so Bedrock's real
        // `us-east-1` legitimately survives beside its placeholder key. What
        // must not survive anywhere is the thing that AUTHENTICATES a row.
        for (const [brand, entry] of Object.entries(keys)) {
            const credential =
                typeof entry === 'string' ? entry : entry.apiKey;
            expect([brand, credential]).toEqual([brand, undefined]);
        }
        // ...and it says so, rather than silently yielding nothing — the
        // difference between "you left these blank" and "you sent nothing".
        expect(unfilled.length).toBeGreaterThan(0);
    });

    /** A brand is usable only when the field that authenticates it is real. */
    it('drops a placeholder field while keeping the real ones beside it', () => {
        const { keys } = liveKeys(
            JSON.stringify({
                azure: {
                    apiKey: 'real-key',
                    baseURL: 'https://<your-resource>.openai.azure.com/openai',
                },
                deepseek: 'sk-…',
                open_router: '   ',
            }),
        );

        // The endpoint is gone, so the Azure row's `baseURL` gate skips it —
        // no call to a host named `<your-resource>`.
        expect(keys).toEqual({ azure: { apiKey: 'real-key' } });
    });

    /**
     * Vertex's builder DEGRADES instead of failing: a credential that is not a
     * parseable service-account JSON falls through to `createGoogleGenerativeAI`
     * — AI Studio, a different endpoint with different auth. That is the right
     * call in production (a user who pasted an `AIzaSy…` key into the Vertex
     * slot still gets a working model), and it is poison here: the row would go
     * green having tested the one transport it is the only coverage for.
     *
     * So when a Vertex credential is present, it must parse. When it is absent
     * the row skips and this asserts nothing — the same shape as every other row.
     */
    it('never lets the Vertex row pass by degrading to AI Studio', () => {
        const credential = key('google_vertex');
        if (!credential) {
            return;
        }
        const parsed = parseSaCredentials(credential);
        expect(parsed?.project_id).toEqual(expect.any(String));
    });

    /**
     * The workflow hands this job a set of secrets; `REPO_SECRET` decides which
     * ones a brand will read. Nothing connected the two and they drifted: the
     * job passed `BYOK_GOOGLE_API_KEY` and `GEMINI_API_KEY` while the Gemini
     * row read neither, so the second-largest model family in production was
     * reported "skipped (no credential)" on a run that was HOLDING its
     * credential. A secret nobody reads is indistinguishable from one nobody
     * set — and the job pays to pass it either way.
     */
    it('reads every credential the CI job passes it', () => {
        const declared = new Set(Object.values(REPO_SECRET).flat());
        for (const name of secretsPassedByCi()) {
            expect([name, declared.has(name)]).toEqual([name, true]);
        }
    });

    /**
     * ...and the reverse. A name in the table that the job never passes reads
     * as a credential we have when we do not: the brand reports "covered" from
     * a developer's shell and skips in CI, which is the failure that is only
     * ever noticed by its absence.
     */
    it('is passed every credential it declares', () => {
        const passed = new Set(secretsPassedByCi());
        for (const [brand, names] of Object.entries(REPO_SECRET)) {
            for (const name of names) {
                expect([brand, name, passed.has(name)]).toEqual([
                    brand,
                    name,
                    true,
                ]);
            }
        }
    });

    /**
     * A brand with no CI-reachable secret can only come from `BYOK_LIVE_KEYS`,
     * so it must be listed in the template — the template is the entire
     * instruction for what a human has to go and find.
     *
     * Adding a row is one edit; remembering the file people copy is a second,
     * and it was already missed once: `openai_compatible_claude` shipped with
     * no fallback and no template entry, discoverable only by reading the rows.
     * A template is documentation only while it is not allowed to be incomplete.
     */
    it('lists every secret-only brand in the template people copy', () => {
        const template = JSON.parse(
            readFileSync(
                join(__dirname, 'testing', 'byok-live-keys.example.json'),
                'utf8',
            ),
        ) as Record<string, unknown>;
        // The two places that tell a human what to FILL IN: a field, or the
        // overrides note for a brand that borrows another's key. Deliberately
        // not "mentioned somewhere in the file" — the weights list names every
        // brand, so a substring search would accept a template with nothing to
        // fill and call that documented.
        const fillable = new Set(Object.keys(template));
        const overrides = JSON.stringify(template._optional_overrides ?? '');
        const passed = new Set(secretsPassedByCi());

        // Follow the borrow chain: `anthropic-fable` is covered by the key
        // `anthropic` resolves, and needs no entry of its own.
        const reachableInCi = (brand: string): boolean => {
            const seen = new Set<string>();
            let b: string | undefined = brand;
            while (b && !seen.has(b)) {
                seen.add(b);
                if ((REPO_SECRET[b] ?? []).some((n) => passed.has(n))) {
                    return true;
                }
                b = BORROWS_FROM[b];
            }
            return false;
        };

        for (const { brand } of LIVE) {
            if (reachableInCi(brand)) {
                continue;
            }
            const named =
                fillable.has(brand) ||
                // Word-bounded, so `minimax` does not pass by being a prefix
                // of `minimax_m3`.
                new RegExp('\\b' + brand + '\\b').test(overrides);
            expect([brand, named]).toEqual([brand, true]);
        }
    });


    it('reports which brands this run actually covered', () => {
        const covered = configured.map((c) => c.brand);
        const skipped = LIVE.filter((c) => !canRun(c)).map((c) => c.brand);
        // Coverage is DATA, not a failure: a PARTIAL secret is a legitimate
        // green, and so is a fork PR with none. Printing it stops "green" from
        // being mistaken for "everything was checked".
        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] covered: ${covered.join(', ') || '(none)'}\n` +
                `[byok-live] skipped (no credential): ${skipped.join(', ') || '(none)'}` +
                // Separate line from "skipped": these brands ARE in the secret,
                // still holding the template's placeholder. Without saying so,
                // filling a key wrong and not filling it at all look identical.
                (UNFILLED.length
                    ? `\n[byok-live] present but still a placeholder: ${UNFILLED.join(', ')}`
                    : ''),
        );
        expect(LIVE.length).toBeGreaterThan(0);

        // ...but ZERO coverage on the WEEKLY run is not data, it is the tier not
        // existing. This job's whole purpose is to spend real tokens against
        // real vendors once a week; if no brand has a credential, it made no
        // call, found no drift, and reported green — which reads exactly like a
        // week in which everything was verified.
        //
        // Scoped to the schedule on purpose. A fork PR, a manual dispatch and a
        // local run all legitimately have no credentials and must stay green;
        // only the cron is claiming to be the safety net.
        if (process.env.BYOK_LIVE_EVENT === 'schedule' && !covered.length) {
            throw new Error(
                'byok-live: the weekly run had no credentials for ANY of the ' +
                    `${LIVE.length} brands, so nothing was checked and green would ` +
                    'mean nothing. Set the BYOK_LIVE_KEYS secret (or any of the ' +
                    'BYOK_* per-brand secrets) — a PARTIAL set is fine and reports ' +
                    'partial coverage.',
            );
        }
    });

    for (const c of LIVE) {
        const credential = credentialFor(c);
        const run = canRun(c) ? it : it.skip;

        run(
            `${c.brand} — ${c.why}`,
            async () => {
                // `LLM.run` — the ONE door, in its agent-loop mode. The first
                // version of this called `resolveModelConfig` + the SDK
                // directly, which skipped everything LLM.run owns: slot
                // resolution, the observability span, and the
                // primary->fallback cascade. The loop mode is used (with no
                // tools and a single step) because it is the only mode that
                // hands back the raw SDK result — and usage is what the
                // reasoning assertion below reads. It is also a real production
                // path: the review agent runs through exactly this door.
                const result = await LLM.run({
                    byokConfig: {
                        ...c.slot,
                        ...slotExtras(c.brand),
                        // Auth may be inherited even when the rest of the slot
                        // is not — see `authFieldsFor`.
                        ...authFieldsFor(c.brand),
                        apiKey: credential,
                        // Bedrock reads a bearer token rather than apiKey.
                        ...((c as any).credentialField
                            ? { [(c as any).credentialField]: credential }
                            : {}),
                    } as unknown as NormalizedModel,
                    messages: [
                        {
                            role: 'user',
                            // Cheap on purpose: the subject under test is the
                            // REQUEST shape, not the answer. Reasoning models
                            // still spend thinking tokens here — that is the
                            // signal we assert on.
                            content: 'Reply with the single word: ok',
                        },
                    ],
                    loop: { tools: {}, maxSteps: 1 },
                    runName: 'byok-live-contract',
                    // A CAP on what one probe can cost. Without it most rows
                    // went out with no `max_tokens` at all and the vendor's own
                    // ceiling applied — for a prompt that asks for one word.
                    // A row that emits a thinking BUDGET needs a cap above it
                    // (the request is rejected otherwise), so it states its own.
                    maxOutputTokens: (c as any).maxOutputTokens ?? 4_096,
                });

                expect(typeof result.text).toBe('string');

                if (c.reasons) {
                    // THE drift detector. A vendor that renames or stops
                    // honouring our reasoning parameter still returns 200 — it
                    // just stops thinking. Something has to prove it thought.
                    //
                    // It CANNOT be the billed reasoning tokens alone, which is
                    // what this asserted before ever running against a real
                    // vendor: five of the eight brands below declare
                    // `usageGranularity: 'output_only'`, meaning the SDK reports
                    // no separate thinking-token count for them — Anthropic bills
                    // thinking INTO output_tokens, and the openai-compatible
                    // brands do the same. Those five would have gone red on the
                    // first run with a real key, for a reporting style rather
                    // than a regression. A weekly job that cries wolf on its
                    // first run gets muted, and a muted job catches nothing.
                    //
                    // So the assertion is "reasoning is OBSERVABLE", by either
                    // signal, and the run prints which one it saw. Both absent is
                    // the real regression: the model stopped thinking. Declaring
                    // the expected signal per brand would be tighter, but nobody
                    // has run this against these vendors yet — so it would be
                    // guessing, which is the mistake being fixed here.
                    const evidence = {
                        brand: c.brand,
                        tokens: reasoningTokens(result.usage),
                        text: (result.reasoningText ?? '').length,
                    };
                    // eslint-disable-next-line no-console
                    console.log(
                        `[byok-live] ${c.brand}: reasoningTokens=${evidence.tokens} reasoningTextChars=${evidence.text}`,
                    );
                    expect({
                        ...evidence,
                        reasoned: evidence.tokens > 0 || evidence.text > 0,
                    }).toMatchObject({ reasoned: true });
                } else if (c.reasons === false) {
                    // The mirror image, and the only way to catch "Off stopped
                    // meaning off". Omitting the disable on an adaptive model
                    // still returns 200 — it just bills thinking the user
                    // declined.
                    const tokens = reasoningTokens(result.usage);
                    const text = (result.reasoningText ?? '').length;
                    // eslint-disable-next-line no-console
                    console.log(
                        `[byok-live] ${c.brand}: OFF path — reasoningTokens=${tokens} reasoningTextChars=${text}`,
                    );
                    expect({
                        brand: c.brand,
                        reasoned: tokens > 0 || text > 0,
                    }).toMatchObject({ reasoned: false });
                }
            },
            120_000,
        );
    }
});

/**
 * The rows above prove the reasoning parameter reaches the vendor. They do NOT
 * prove the thing production actually does, because they call the model the way
 * no production code does: a plain message list with no schema, through the SDK
 * rather than through the one door.
 *
 * There IS one door — `LLM.run` — and it owns three things before any executor
 * runs: the slot resolution (task -> model + key), the observability span, and
 * the primary->fallback cascade (`runWithModelFailover`). Underneath it picks an
 * executor: agent loop, structured, or text. So these go through `LLM.run`
 * itself; reaching for `runStructuredReviewCall` beneath it would skip the
 * routing and the failover, which is the same mistake one level down.
 *
 * The structured executor chooses an OUTPUT CHANNEL from `planStructuredCall`
 * before it ever touches the SDK:
 *
 *   as-is              issue the structured call unchanged
 *   suppress-thinking  turn reasoning OFF first, THEN force the tool — because
 *                      the Anthropic protocol rejects a forced tool_choice while
 *                      thinking with "tool_choice 'required' is incompatible
 *                      with thinking enabled"
 *   reroute-json       never force a tool at all; put the schema in the prompt —
 *                      for models that cannot stop thinking AND cannot take a
 *                      forced tool_choice
 *
 * Those two non-trivial plans are the 400s this whole layer exists to prevent,
 * and no amount of plain-generateText coverage can see them: the failure needs a
 * schema, a forced tool call and a thinking model in the same request. So these
 * go through the REAL entry point, with the real schema machinery, and assert
 * the parsed object comes back.
 */
const STRUCTURED_LIVE = [
    {
        brand: 'anthropic',
        plan: 'suppress-thinking',
        why: 'Claude adaptive thinks by default; forcing a tool while it thinks is a 400. The plan must disable thinking FIRST',
        slot: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            reasoningEffort: 'high',
        },
    },
    {
        brand: 'anthropic_compatible',
        plan: 'reroute-json',
        why: 'k3 cannot stop thinking and its endpoint cannot take a forced tool_choice — the only sound path is schema-in-prompt. If the plan ever says otherwise this 400s live',
        slot: {
            provider: 'anthropic_compatible',
            model: 'k3',
            baseURL: 'https://api.kimi.com/coding',
            reasoningEffort: 'high',
        },
    },
] as const;

describe('BYOK structured output — LIVE, through LLM.run (the one door)', () => {
    for (const c of STRUCTURED_LIVE) {
        const apiKey = key(c.brand);
        const run = apiKey ? it : it.skip;

        run(
            `${c.brand} (${c.plan}) — ${c.why}`,
            async () => {
                // The schema is deliberately trivial: the subject under test is
                // the CHANNEL, not the model's ability to fill a rich object.
                const schema = z.object({
                    ok: z.boolean(),
                    word: z.string(),
                });

                // `LLM.run` — THE one door, not the executor beneath it.
                // Calling `runStructuredReviewCall` directly (the first version
                // of this block) skipped what LLM.run owns: slot resolution and
                // the primary->fallback cascade in `runWithModelFailover`.
                const result = await LLM.run({
                    byokConfig: {
                        ...c.slot,
                        ...slotExtras(c.brand),
                        apiKey,
                    } as unknown as NormalizedModel,
                    user: 'Reply with ok=true and word="ok".',
                    runName: 'byok-live-structured',
                    schema,
                    maxOutputTokens: 4_096,
                });

                // Getting a parsed object back means the whole composition held:
                // the plan picked a channel the model accepts, the schema
                // survived the wire, and the envelope parsed.
                expect(schema.safeParse(result).success).toBe(true);
            },
            120_000,
        );
    }
});
