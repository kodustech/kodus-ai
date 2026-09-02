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
 * Every credential is a GitHub Actions secret, passed by the `byok-live` job in
 * .github/workflows/contract-tests.yml. There is no override file and no JSON
 * blob: a brand reads the secret `REPO_SECRET` names for it, or derives
 * `BYOK_<BRAND>_API_KEY`, and a brand that borrows reads the lender's.
 *
 *     BYOK_ANTHROPIC_API_KEY   -> anthropic, -modern, -opus-5, openai_compatible_claude
 *     BYOK_OPENAI_API_KEY      -> openai, openai_compatible_gpt5
 *     BYOK_ZHIPU_API_KEY       -> zai, zai_glm53 (Zhipu is Z.ai, the GLM vendor)
 *     BYOK_GOOGLE_API_KEY      -> google_gemini, google_gemini_flash
 *     BYOK_MOONSHOT_API_KEY    -> moonshot_code
 *     BYOK_DEEPSEEK_API_KEY    -> deepseek
 *     BYOK_OPEN_ROUTER_API_KEY -> open_router, _glm, _qwen
 *     BYOK_AMAZON_BEDROCK_API_KEY -> amazon_bedrock (bearer token)
 *
 * Adding a brand needs no code beyond its row: create `BYOK_<BRAND>_API_KEY`,
 * pass it in the workflow, and the invariants at the bottom of this file check
 * the two against each other in BOTH directions — a secret nobody reads and a
 * row nothing can authenticate are each a failure, not a silent skip.
 *
 * A case with no key SKIPS — it never fails. A run with partial credentials
 * reports partial coverage, so contributors and forks see green, not a false red.
 *
 * ─── ONE KEY, SEVERAL BRANDS ───────────────────────────────────────────────
 * The Claude brands hold the SAME key — they are generations and transports of
 * one account, split into separate brands only because their request shapes are
 * mutually exclusive. `BORROWS_FROM` is what says so, in one place, instead of
 * each row naming an env var and the two drifting.
 *
 * The baseURLs written into the rows are the vendors' public endpoints, kept in
 * the file because reading a row should tell you which vendor it talks to. They
 * are not configuration: changing where a row points is a code change, reviewed
 * like any other, now that there is no secret that can silently redirect it.
 */

jest.mock('@libs/common/utils/crypto', () => ({
    decrypt: (v: string) => v,
    encrypt: (v: string) => v,
}));


import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { LLM } from './llm';
import type { NormalizedModel } from './byok-config';

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
    'anthropic-modern': 'anthropic',
    'anthropic-opus-5': 'anthropic',
    anthropic_compatible: 'moonshot',
    moonshot_code: 'moonshot',
    zai_glm53: 'zai',
    bedrock_opus47: 'amazon_bedrock',
    google_gemini_flash: 'google_gemini',
    open_router_gemini: 'open_router',
    open_router_glm: 'open_router',
    open_router_qwen: 'open_router',
    openai_compatible_gpt5: 'openai',
    openai_compatible_claude: 'anthropic',
};

/**
 * The credential for a brand: the repo secret that holds it, then the same
 * question asked of the brand it borrows from. There is no per-brand override
 * file any more — every credential is a GitHub Actions secret.
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
        const names = REPO_SECRET[b] ?? [`BYOK_${b.toUpperCase()}_API_KEY`];
        const fromEnv = names.map((n) => process.env[n]).find(Boolean);
        if (fromEnv) {
            return fromEnv;
        }
        b = BORROWS_FROM[b];
    }
    return undefined;
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

/** Does this row have SOMETHING to authenticate with? */
const canRun = (row: { brand: string; requires?: () => boolean }): boolean => {
    if (row.requires && !row.requires()) {
        return false;
    }
    return !!key(row.brand);
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
        .filter((n) => n !== 'BYOK_LIVE_EVENT');
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
    // GLM-5.3 is not a version bump of the row above: production reaches it
    // through z.ai's CODING endpoint (`/api/coding/paas/v4`), a different host
    // path from the `/api/paas/v4` the 5.2 row uses, and the two are configured
    // separately upstream. Same vendor, same key, different wire — so it earns a
    // row instead of replacing one.
    {
        brand: 'zai_glm53',
        why: 'the CODING endpoint, not the one the glm-5.2 row above uses',
        slot: {
            provider: 'openai_compatible',
            model: 'glm-5.3',
            baseURL: 'https://api.z.ai/api/coding/paas/v4',
            reasoningEffort: 'medium',
            temperature: 0,
        },
        reasons: true,
    },
    // The two Google rows are the tier-0 pair, and they are two rows rather than
    // one because they are two different models: a pro and a flash.
    //
    // They used to carry `maxOutputTokens: 26_000` and `effort: high`, copied
    // from the gemini-2.5-flash row they replaced. That row needed the headroom
    // because 2.5 emitted a NUMERIC `thinkingBudget` that had to fit under the
    // model's 24,576 ceiling. These ids emit `thinkingLevel: 'low'|'high'` —
    // there is no number to fit, so the ceiling was protecting against a
    // constraint that does not exist here, at 26,000 tokens of authorised spend
    // each. `low` per the rule below: the level is not the subject of this row. `-customtools` is not a suffix we can drop —
    // it is the id production configures, in 24 slots.
    {
        brand: 'google_gemini',
        why: 'the tier-0 pro id, with the custom-tools variant production actually configures',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-3.1-pro-preview-customtools',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'google_gemini_flash',
        why: 'the tier-0 flash id — same key and transport as the row above, different thinking ceiling',
        slot: {
            provider: 'google_gemini',
            model: 'gemini-3-flash-preview',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    // The pro id's SECOND production config. 23 of its 24 slots go straight to
    // AI Studio (the row above); one goes through OpenRouter, where the model is
    // namespaced `google/…` and our `reasoning:{effort}` has to survive a
    // translation Google never sees. One slot is still a config, and it is the
    // config a whole transport is represented by.
    {
        brand: 'open_router_gemini',
        why: 'the tier-0 pro id through the aggregator instead of AI Studio — a different namespace and a translated reasoning field',
        slot: {
            provider: 'open_router',
            model: 'google/gemini-3.1-pro-preview-customtools',
            reasoningEffort: 'medium',
            // Pinned for the same reason `open_router_glm` is: OpenRouter picks
            // an upstream per call and they do not all translate the reasoning
            // field alike. Unpinned, the row asserts the routing lottery.
            openrouterProviderOrder: ['google-vertex'],
            openrouterAllowFallbacks: false,
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
        brand: 'anthropic-opus-5',
        why: 'Opus 5 shares the adaptive shape with the 4.7 row above, and shares nothing else: it is the most expensive model any customer runs, so a request shape that regresses here costs the most per review. `low`, not high — the SHAPE is the subject and one word needs no budget',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    // NOT covered, deliberately: `novita` (3 production shapes). Verified against
    // novita.ai/docs — the vendor exposes no reasoning parameter at all, so there
    // is no shape of ours that could drift. Its DeepSeek models reason by
    // default; the level simply is not expressible on that endpoint.

    // ── mappings added after this tier was written, and unmonitored until now ──
    // Each is a shape we now emit in production and nothing live was checking.
    {
        brand: 'amazon_bedrock',
        why: 'Claude on Converse takes the adaptive shape inside additionalModelRequestFields, and this transport cannot express an explicit disable (5 production slots)',
        slot: {
            provider: 'amazon_bedrock',
            // The `us.` prefix is not decoration — it names an INFERENCE
            // PROFILE, and Claude on Bedrock is not servable without one:
            //   "Invocation of model ID anthropic.claude-sonnet-4-6 with
            //    on-demand throughput isn't supported. Retry your request with
            //    the ID or ARN of an inference profile that contains this model."
            //
            // This row carried the bare id because it was copied from a real
            // production slot — and that slot is one of the five Bedrock-Claude
            // configs in the corpus, the ONLY one without a prefix. It has
            // never worked. It sits in a `fallback`, which is why nobody
            // noticed: a fallback only runs once the primary has already
            // failed, so its error arrives as part of an outage instead of on
            // its own.
            model: 'us.anthropic.claude-sonnet-4-6',
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

    // ── gaps found by weighing the rows against what production actually runs.
    // Each is a (provider + family) combination with real slots behind it and no
    // live row, which is how a transport-specific rule goes unchecked. ────────
    // Opus 4.7's SECOND production config. The row above runs it on Anthropic
    // native (4 slots); this one is Bedrock Converse (1 slot), where the SAME
    // model takes the adaptive shape inside `additionalModelRequestFields`
    // instead of at the top level. Separate from the Bedrock row above because
    // that one is a 4.6 — this pins the 4.7+ shape ON this transport, and the
    // two generations are a 400 in each other's form.
    {
        brand: 'bedrock_opus47',
        why: 'Opus 4.7 on Converse — the 4.7+ shape inside additionalModelRequestFields, which the 4.6 Bedrock row above does not exercise',
        slot: {
            provider: 'amazon_bedrock',
            // `global.` is the routing-anywhere profile, and it is the form the
            // production slot carries. Not derived from a region: unlike `us.`
            // or `eu.`, it is a deliberate choice by whoever configured it.
            model: 'global.anthropic.claude-opus-4-7',
            awsRegion: process.env.API_AWS_REGION || 'us-east-1',
            reasoningEffort: 'low',
        },
        credentialField: 'awsBearerToken' as const,
        reasons: true,
    },
    {
        brand: 'open_router_glm',
        why: 'OpenRouter is 67 production shapes and was represented by ONE family. GLM is its largest (17 shapes) and behaves nothing like DeepSeek there: the aggregator normalises `reasoning:{effort}` for every upstream, so what this row checks is whether OpenRouter still translates it for a Z.ai model rather than passing our field through to an upstream that wants `thinking`',
        slot: {
            provider: 'open_router',
            model: 'z-ai/glm-5.2',
            reasoningEffort: 'medium',
            // PINNED, because the first two live runs of this row returned 135
            // reasoning tokens and then 0. Nothing about our request changed:
            // OpenRouter picks an upstream per call, and they do not all
            // translate `reasoning:{effort}` the same way. Unpinned, the row
            // asserts the routing lottery rather than the request — and a
            // weekly job that goes red at random is one people learn to ignore.
            //
            // Pinning is also the faithful shape: production slots pin, with
            // exactly this pair of fields (`["z-ai"]`, `["novita","z-ai",
            // "siliconflow"]` and `["wafer/fp4"]` all appear in the corpus).
            openrouterProviderOrder: ['z-ai'],
            openrouterAllowFallbacks: false,
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

    // ── the audit's open questions: cases where the DOCS and our code disagree,
    // or where no readable doc exists at all. Offline tests cannot settle any of
    // these — they prove what we SEND, and the question is what the vendor
    // ACCEPTS. Each one is a claim currently resting on inference. ──────────
    // The SAME vendor as `moonshot_code` below, over the ANTHROPIC protocol
    // instead of the OpenAI one — a different endpoint emitting a different
    // body, so it is its own row. It is also the only live exercise of the
    // `reroute-json` structured-output plan (see STRUCTURED_LIVE): k3 cannot
    // stop thinking AND cannot take a forced tool_choice, and no other model in
    // this table has that pair.
    {
        brand: 'anthropic_compatible',
        why: 'the SAME Kimi over the ANTHROPIC protocol, where the emitted shape differs from the openai_compatible row below — and k3 is always-thinking, so the rule is "omit the disable, pin temperature to 1" rather than "send one"',
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
        // 2_048, not 6_144: the SDK adds the 5,000-token thinking budget ON TOP
        // of what is declared, so this row went out at 11,144 — the most
        // expensive ceiling in the table, for a prompt asking for one word.
        maxOutputTokens: 2_048,
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
                    // OpenAI reasoners reject `max_tokens` and take this
                    // instead — the rename the compatible transport performs.
                    // Reading only `max_tokens` reported cap=0 for that row, so
                    // the per-row ceiling below could not see it AT ALL: the one
                    // guard against a row authorising unbounded spend was blind
                    // to the exact row whose field name had just changed.
                    sent?.max_completion_tokens ??
                    sent?.generationConfig?.maxOutputTokens ??
                    sent?.max_output_tokens ??
                    sent?.inferenceConfig?.maxTokens ??
                    0;
                // A row with NO ceiling is the failure this probe exists to
                // prevent; zero must never read as "cheap".
                expect([c.brand, cap]).not.toEqual([c.brand, 0]);
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
        // nothing would sum to zero and pass. Derived from the row count rather
        // than pinned to a number: a fixed floor goes stale the moment the table
        // shrinks, and then it fails for the size of the table instead of for
        // the thing it guards.
        expect(total).toBeGreaterThan(LIVE.length * 1_000);
    }, 120_000);

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
        // Two ways a brand reads a secret: the table names it (a legacy name
        // that predates this file), or the brand DERIVES it. Both count, which
        // is what makes the convention real — adding a row and a
        // `BYOK_<BRAND>_API_KEY` secret needs no third edit here.
        const declared = new Set([
            ...Object.values(REPO_SECRET).flat(),
            ...LIVE.map((c) => `BYOK_${c.brand.toUpperCase()}_API_KEY`),
        ]);
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
     * Every row must be reachable from a secret the CI job passes.
     *
     * This replaces two checks that kept a copy-me template honest. The template
     * is gone — there is no per-brand override file any more, every credential
     * is a GitHub Actions secret — and with it went the only way a row could be
     * authenticated from outside the workflow. So the question is no longer
     * "is this brand documented", it is the stricter one: a row the workflow
     * cannot reach can NEVER run. It skips, forever, and the coverage report
     * says "no credential" as though someone merely has to go find one.
     *
     * Both directions matter and the other one is above: this asserts no row is
     * unreachable, `reads every credential the CI job passes it` asserts no
     * secret is passed that no brand will read.
     */
    it('can reach a credential for every row it declares', () => {
        const passed = new Set(secretsPassedByCi());

        // Follow the borrow chain: `google_gemini_flash` is covered by whatever
        // `google_gemini` resolves, and needs no secret of its own.
        const reachableInCi = (brand: string): boolean => {
            const seen = new Set<string>();
            let b: string | undefined = brand;
            while (b && !seen.has(b)) {
                seen.add(b);
                // Both ways a brand reads a secret: the table names it, or the
                // brand derives `BYOK_<BRAND>_API_KEY`.
                const names = REPO_SECRET[b] ?? [
                    `BYOK_${b.toUpperCase()}_API_KEY`,
                ];
                if (names.some((n) => passed.has(n))) {
                    return true;
                }
                b = BORROWS_FROM[b];
            }
            return false;
        };

        for (const { brand } of LIVE) {
            expect([brand, reachableInCi(brand)]).toEqual([brand, true]);
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
                `[byok-live] skipped (no credential): ${skipped.join(', ') || '(none)'}`,
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
                    'mean nothing. Set the BYOK_* secrets the workflow passes (or any of the ' +
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
                        // Auth may be inherited even when the rest of the slot
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
