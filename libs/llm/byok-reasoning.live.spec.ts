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
 *     BYOK_OPENAI_API_KEY      -> openai, openai_compatible_gpt5, openai_gpt56,
 *                                 openai_compatible_gpt56, openai_gpt6_astra
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
import { KODUS_CATALOG } from './providers/kodus/catalog';

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
    // Not a customer key: the `kodus` provider routes over OUR upstream accounts
    // and reads the platform key from this env at build time — the slot carries
    // none. Naming it here is what lets the row gate and the module agree on the
    // one variable, and what the credential invariants check against the job.
    kodus: ['API_KODUS_PROVIDER_FIREWORKS_API_KEY'],
};

/**
 * The Kodus catalog as live rows — GENERATED, never hand-written.
 *
 * `kodus` is the provider that bills a customer's credits: the org picks from a
 * closed catalog and we route the call over our own upstream accounts. A model
 * the upstream retires or renames does not degrade there — `build()` refuses an
 * id the catalog cannot price, so the paying customer's review simply fails. That
 * is the stale-KODUS_TRIAL_MODEL incident this workflow's header cites, one
 * provider over, and until now nothing called these models at all.
 *
 * Generated from `KODUS_CATALOG` so the two cannot drift: adding a model to the
 * price list adds its row, removing one removes it. A hand-written row per model
 * is exactly the list that goes stale the week after someone edits the catalog.
 *
 * Measured before writing them (2026-09-18, direct against Fireworks): all five
 * current entries answered and billed reasoning tokens, so `reasons: true` is a
 * fact about them, not a hope. Going through `LLM.run` rather than a raw call is
 * the point — it exercises the routing brand, the closed-catalog gate and the
 * delegation to the upstream module, which a curl never touches.
 */
const kodusBrand = (id: string): string =>
    `kodus_${id.split('/').pop()!.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`;

function kodusBorrows(): Record<string, string> {
    return Object.fromEntries(KODUS_CATALOG.map((m) => [kodusBrand(m.id), 'kodus']));
}

function kodusCatalogRows() {
    return KODUS_CATALOG.map((m) => ({
        brand: kodusBrand(m.id),
        why: `Kodus-as-provider: ${m.id} is a model we BILL credits for. A retired or renamed upstream id does not degrade — the closed catalog refuses it and the customer's review fails`,
        slot: {
            provider: 'kodus',
            model: m.id,
            reasoningEffort: 'medium',
        },
        reasons: true,
    }));
}

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
    moonshot_code: 'moonshot',
    zai_glm53: 'zai',
    bedrock_opus47: 'amazon_bedrock',
    google_gemini_flash: 'google_gemini',
    open_router_gemini: 'open_router',
    open_router_glm: 'open_router',
    open_router_qwen: 'open_router',
    openai_compatible_gpt5: 'openai',
    openai_compatible_claude: 'anthropic',
    openai_gpt56: 'openai',
    openai_compatible_gpt56: 'openai',
    openai_gpt6_astra: 'openai',
    google_vertex_gemini: 'google_vertex',
    google_vertex_modern: 'google_vertex',
    google_vertex_legacy: 'google_vertex',
    ...kodusBorrows(),
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

/**
 * A dead credential is not drift — and this job spent two Mondays saying it was.
 *
 * Seven rows failed on 2026-09-07 and again on 2026-09-14 with `API key is
 * invalid`, `Forbidden` and `INVALID_PAYMENT_INSTRUMENT`, and the alert they
 * fired read "a provider changed how a model is configured" — the one thing
 * that had demonstrably NOT happened. The request shape was never tested at
 * all: the call died at the door.
 *
 * The failure stays a failure. A dead key means zero live coverage for every
 * row that borrows it, which is precisely what this tier exists to notice, so
 * downgrading it to a skip would hide the hole instead of the noise. What
 * changes is that the message names the real cause — because an alert that
 * misnames its cause is worse than no alert. Someone reads "provider drifted",
 * goes looking for a changelog, finds nothing, and learns to ignore Monday.
 */
/*
 * Every alternative here is a string a vendor ACTUALLY returned, not a guess at
 * how one might phrase it. `incorrect api key provided` is in the list because
 * the first version of this regex missed it and a local run caught that: OpenAI
 * does not say "invalid", it says "incorrect", and a classifier that reads only
 * the Anthropic wording sends the exact same misleading alert for the exact
 * same cause. `dunning decision is deny` joined it the same way: Vertex says
 * that when the GCP project's billing is delinquent, and nothing about the
 * request shape is being judged when it does.
 * Add a phrasing here only after seeing it in a log.
 */
const CREDENTIAL_FAILURE =
    /(api key is invalid|invalid api key|incorrect api key|invalid[ _-]?anthropic[ _-]?api[ _-]?key|invalid[ _-]?x-api-key|invalid_api_key|authentication[ _]?error|unauthorized|forbidden|invalid_payment_instrument|access denied|permission denied|expired token|could not be authenticated|dunning decision is deny|billing[ _]?(is )?(disabled|not enabled)|has not enabled billing)/i;

const onlyDrift = async <T>(brand: string, call: Promise<T>): Promise<T> => {
    try {
        return await call;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!CREDENTIAL_FAILURE.test(message)) {
            throw err;
        }
        throw new Error(
            `byok-live: ${brand} never reached the model. This is a CREDENTIAL ` +
                `failure, NOT provider drift — the secret this row runs on is dead ` +
                `(expired, rotated, or unpaid), so the reasoning shape was not ` +
                `tested at all, and every row borrowing the same key is equally ` +
                `uncovered. Rotate the secret and re-run. Do NOT read this as a ` +
                `model changing its reasoning contract.\n` +
                `Provider said: ${message}`,
            { cause: err },
        );
    }
};

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
    // Matched on the SPEC PATH, not on the whole command: pinning the exact
    // command string meant that prefixing it (NODE_OPTIONS, for the Vertex
    // rows' dynamic import) silently detached this parser from the job, and
    // all three credential invariants went red for a reason that had nothing
    // to do with credentials.
    const runAt = workflow.search(
        /^\s+run:.*byok-reasoning\.live\.spec\.ts/m,
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
            reasoningEffort: 'medium', // prod: 16 de 24 slots usam medium; 7 high, 1 ausente
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
            // `google-ai-studio` — the slug, read from OpenRouter's own
            // /models/<id>/endpoints, not guessed. The first version of this row
            // pinned `google-vertex`, which is not a slug this model is served
            // under: with `allow_fallbacks:false` that excluded every endpoint
            // and the call came back `No endpoints found for <model>` — a
            // message that reads like the model is gone, when the pin was wrong.
            //
            // Pinned for the same reason `open_router_glm` is: OpenRouter picks
            // an upstream per call and they do not all translate the reasoning
            // field alike. This model has exactly ONE endpoint today, so the pin
            // costs nothing now and holds the row still if Google adds a second.
            openrouterProviderOrder: ['google-ai-studio'],
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
            reasoningEffort: 'high', // prod: 10 de 17 slots usam high
        },
        reasons: true,
    },
    {
        brand: 'openai',
        why: 'native reasoning effort on the Responses API',
        slot: {
            provider: 'openai',
            model: 'gpt-5.4',
            reasoningEffort: 'medium', // prod: 18 de 22 slots usam medium
        },
        reasons: true,
    },
    // ── The 5.6 line: 18 production slots across three transports and, until
    // now, not one row. That is the largest uncovered family in the corpus —
    // bigger than every brand below it that does have a row — and it went
    // uncovered for the ordinary reason: the rows were written when 5.4 was the
    // newest id, and nothing re-asks that question when a vendor ships a line.
    //
    // Two rows, not five. The three ids (sol/luna/terra) are one family and the
    // subject is the TRANSPORT, which is where the shapes actually differ: the
    // Responses API natively, and the OpenAI protocol through a proxy. Both ride
    // BYOK_OPENAI_API_KEY, so the pair costs no new secret.
    // ── MEASURED 2026-09-18, and the result is the finding ────────────────────
    // Both 5.6 rows came back 200 with ZERO reasoning tokens, on two different
    // transports, while the control group in the SAME run reasoned normally:
    //
    //   gpt-5.4        native   medium -> 11 reasoning tokens
    //   gpt-5.4        compat   medium -> 18
    //   gpt-6-astra    native   medium -> 20
    //   gpt-5.6-terra  native   medium ->  0
    //   gpt-5.6-sol    compat   HIGH   ->  0
    //
    // Our side is not the problem: the request bodies were captured offline and
    // the field goes out, identical in shape to the ones that DO reason —
    // `reasoning:{effort,summary}` on the Responses API, `reasoning_effort` on
    // the compatible transport. A higher effort on the compat row changed
    // nothing, which is what rules out "the prompt was too easy".
    //
    // So these rows carry `reasons: false`, the same way `openai_compatible_claude`
    // does below: it pins the gap rather than asserting a behaviour we wish for.
    // 18 production slots run a gpt-5.6 with an effort configured, and that
    // effort currently buys nothing. The day it starts buying something — or the
    // day a 5.6 model begins reasoning on its own — these rows go red and
    // somebody gets to find out on purpose.
    //
    // ── RE-MEASURED 2026-09-23: the NATIVE half closed ───────────────────────
    // `gpt-5.6-terra` on the Responses API, same `medium` effort, same request
    // shape, no change on our side:
    //
    //   gpt-5.6-terra  native   medium -> 29 reasoning tokens (was 0)
    //   gpt-5.6-sol    compat   HIGH   ->  0                  (unchanged)
    //
    // The row went red for the reason it was written to go red, so the native
    // one now asserts the behaviour instead of the gap. The compat row keeps
    // `reasons: false`: the same family, the same key, still zero. That the two
    // moved apart is itself the finding — whatever changed is in the Responses
    // API, not in the model, because the OpenAI-protocol transport hitting the
    // vendor's own endpoint still gets nothing for an effort it sends.
    {
        brand: 'openai_gpt56',
        why: 'the 5.6 line is 18 production slots and had NO row — the biggest uncovered family in the corpus. terra is its largest native group (5 slots, 3 at medium), and the id is a generation newer than every OpenAI row here',
        slot: {
            provider: 'openai',
            model: 'gpt-5.6-terra',
            reasoningEffort: 'medium', // prod: 3 de 5 slots do terra usam medium; 1 high, 1 ausente
        },
        // Was a known gap; closed on its own between 2026-09-18 and 2026-09-23
        // with no change on our side (29 reasoning tokens at the same `medium`).
        // `knownGap` is gone with it — this row now verifies reasoning rather
        // than documenting its absence, which is the whole point of having
        // written the gap down as an assertion instead of a comment.
        reasons: true,
    },
    {
        brand: 'openai_compatible_gpt56',
        // Production points these at FIVE distinct customer proxies (the corpus
        // holds them redacted). None of them is ours to call, and a row that
        // named one would be testing that customer's gateway rather than the
        // request we build — so this points at the vendor's own endpoint, the
        // same choice `openai_compatible_gpt5` makes one row down.
        why: 'sol is 5 production slots and every one of them rides an OpenAI-protocol proxy rather than the native API — a different transport for the newest reasoner id, and the majority store high',
        slot: {
            provider: 'openai_compatible',
            model: 'gpt-5.6-sol',
            baseURL: 'https://api.openai.com/v1',
            reasoningEffort: 'high', // prod: 3 de 5 slots do sol usam high; 1 medium, 1 ausente
        },
        // A KNOWN GAP, not a satisfied expectation. `reasons: false` is the
        // right assertion — it is what was measured — but it makes the row
        // green in exactly the degraded state it exists to document, and the
        // coverage log cannot tell "verified reasoning" from "verified absence
        // of it". `knownGap` is printed on its own line so a green weekly run
        // never reads as "this brand is fine".
        knownGap: true,
        // Measured 0 even at `high` — the effort level is not the variable.
        reasons: false,
    },
    // ── gpt-6: ZERO production slots today, and the row is still justified —
    // for a different reason than every row above it, so it says so rather than
    // borrowing their argument.
    //
    // PR #1952 taught `isOpenAiReasonerId` a whole new family and
    // `openaiReasoningConfig` a new level set: gpt-6 gets low/medium/high where
    // gpt-5 exposes only medium/high. Both claims are a regex and a table read
    // from a doc — offline facts about a model nothing has ever called. The
    // first customer to store a gpt-6 slot is not the right person to discover
    // that OpenAI disagrees.
    //
    // `medium`, not `low`, even though `low` is the level the family newly
    // claims: this file already paid to learn that a low-effort row on this
    // prompt returns zero reasoning tokens while behaving exactly as documented
    // (see bedrock_opus47). A row that goes red for that is a row people mute.
    // So the level stays where the prompt is known to make a reasoner think, and
    // `low` on gpt-6 remains untested — deliberately, and written down.
    {
        brand: 'openai_gpt6_astra',
        why: 'the newest family is detected by REGEX and configured from a table, both offline — nothing has ever called it. Proves OpenAI accepts the reasoning shape #1952 taught us to build, before a customer stores the first gpt-6 slot',
        slot: {
            provider: 'openai',
            model: 'gpt-6-astra',
            reasoningEffort: 'medium',
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
            // `high`, NOT the file's `low` default, and this is the one place the
            // level HAS to be the subject. AWS documents adaptive effort as:
            // `high` (default) "Claude always thinks"; `medium` "may skip
            // thinking for very simple queries"; `low` "minimizes thinking,
            // skips thinking for simple tasks". This row's prompt asks for one
            // word — the simplest task there is — so at `low` a model that is
            // working perfectly returns ZERO reasoning tokens, and `reasons:
            // true` fails for the documented behaviour instead of a regression.
            // Proven live: bedrock_opus47 came back 200 with reasoningTokens=0.
            reasoningEffort: 'medium', // prod: 11 de 17 slots usam medium; nenhum usa low
        },
        reasons: true,
    },
    {
        brand: 'anthropic-modern',
        why: 'THE 4.6->4.7 boundary: 4.7+ REJECTS budgetTokens outright, so sending the legacy shape here is a hard 400. Three production shapes run claude-opus-4-7',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-4-7',
            // `high`, NOT the file's `low` default, and this is the one place the
            // level HAS to be the subject. AWS documents adaptive effort as:
            // `high` (default) "Claude always thinks"; `medium` "may skip
            // thinking for very simple queries"; `low` "minimizes thinking,
            // skips thinking for simple tasks". This row's prompt asks for one
            // word — the simplest task there is — so at `low` a model that is
            // working perfectly returns ZERO reasoning tokens, and `reasons:
            // true` fails for the documented behaviour instead of a regression.
            // Proven live: bedrock_opus47 came back 200 with reasoningTokens=0.
            // `high`, not the `medium` that 2 of the 5 production slots use.
            //
            // Measured, not assumed: at `medium` this row came back 200 with
            // reasoningTokens=0, while `anthropic` (sonnet-4-6) at the SAME
            // effort, prompt, transport and key returned 50. Opus 4.7 is the
            // stronger model, so it finds this prompt easy enough to skip —
            // which is `medium` behaving exactly as AWS documents it ("moderate
            // thinking, may skip").
            //
            // An adaptive model at `medium` DECIDES per request, so neither
            // `reasons: true` nor `false` is a stable assertion there — it would
            // flake, and a weekly job that flakes gets muted. `high` is the only
            // level AWS documents as "Claude always thinks", so it is the level
            // at which this row's drift detector means anything. It is also what
            // 3 of the 5 slots use.
            //
            // WORTH KNOWING SEPARATELY: the 2 slots on `medium` are paying Opus
            // prices for reviews that may carry no reasoning at all.
            reasoningEffort: 'high',
        },
        // NO reasoning assertion — deliberately.
        //
        // The reason recorded here first was that "adaptive means the MODEL
        // decides per request". That reading is wrong, and the correction is
        // worth keeping because the same symptom is now on the Bedrock row
        // below: `thinking.display` defaults to `omitted` from Opus 4.7
        // (@ai-sdk/anthropic schema, "default for Opus 4.7+"), where 4.6 and
        // earlier default to `summarized`. The model reasons and is billed for
        // it either way — Anthropic's pricing table states the billed count is
        // identical — the response just carries empty thinking blocks unless
        // `display: 'summarized'` is asked for.
        //
        // A claim recorded here on 2026-09-23 and withdrawn the same day: that
        // Anthropic's `output_tokens_details.thinking_tokens` reflects the raw
        // reasoning rather than the text returned, so the count would survive
        // `omitted`. The vendor does document that. This run cannot corroborate
        // it, and nothing here should be read as if it had:
        //
        //     anthropic-modern  inputTokens 53  outputTokens 8  text 8  reasoning 0
        //
        // `output_tokens` is the billed output and it equals the text exactly,
        // so there is no room in it for thinking that happened and went
        // unreported. Nothing was hidden because nothing was generated — which
        // does confirm the zero is about the request, but leaves the survival
        // question untested, since a counter with nothing to count proves
        // neither direction. It stays a vendor statement, not a measurement.
        //
        // Asked directly with the shape below at effort `high`, it answered:
        //
        //     content blocks: [text]        (no thinking block)
        //     usage.output_tokens_details.thinking_tokens: 0
        //
        // The vendor itself reports zero. Meanwhile sonnet-4-6 at `medium` and
        // opus-5 at `high` — same provider, same key, same prompt, structurally
        // identical request (verified on the wire) — both reason. So `true`
        // would fail today and `false` would fail the day it decides to think:
        // neither is stable, and a weekly job that flakes gets muted.
        //
        // What this row is FOR is unaffected: 4.7+ rejects `budgetTokens`
        // outright, so a regression that sends the legacy shape here is a hard
        // 400 and this row catches it. The reasoning signal was always the
        // secondary check; on this model it is not a check at all.
    },
    {
        brand: 'anthropic-opus-5',
        why: 'Opus 5 shares the adaptive shape with the 4.7 row above, and shares nothing else: it is the most expensive model any customer runs, so a request shape that regresses here costs the most per review. `low`, not high — the SHAPE is the subject and one word needs no budget',
        slot: {
            provider: 'anthropic',
            model: 'claude-opus-5',
            // `high`, NOT the file's `low` default, and this is the one place the
            // level HAS to be the subject. AWS documents adaptive effort as:
            // `high` (default) "Claude always thinks"; `medium` "may skip
            // thinking for very simple queries"; `low` "minimizes thinking,
            // skips thinking for simple tasks". This row's prompt asks for one
            // word — the simplest task there is — so at `low` a model that is
            // working perfectly returns ZERO reasoning tokens, and `reasons:
            // true` fails for the documented behaviour instead of a regression.
            // Proven live: bedrock_opus47 came back 200 with reasoningTokens=0.
            reasoningEffort: 'high',
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
            // `high`, NOT the file's `low` default, and this is the one place the
            // level HAS to be the subject. AWS documents adaptive effort as:
            // `high` (default) "Claude always thinks"; `medium` "may skip
            // thinking for very simple queries"; `low` "minimizes thinking,
            // skips thinking for simple tasks". This row's prompt asks for one
            // word — the simplest task there is — so at `low` a model that is
            // working perfectly returns ZERO reasoning tokens, and `reasons:
            // true` fails for the documented behaviour instead of a regression.
            // Proven live: bedrock_opus47 came back 200 with reasoningTokens=0.
            reasoningEffort: 'medium', // prod: 11 de 17 slots do sonnet-4-6 usam medium
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
            // `high`, NOT the file's `low` default, and this is the one place the
            // level HAS to be the subject. AWS documents adaptive effort as:
            // `high` (default) "Claude always thinks"; `medium` "may skip
            // thinking for very simple queries"; `low` "minimizes thinking,
            // skips thinking for simple tasks". This row's prompt asks for one
            // word — the simplest task there is — so at `low` a model that is
            // working perfectly returns ZERO reasoning tokens, and `reasons:
            // true` fails for the documented behaviour instead of a regression.
            // Proven live: bedrock_opus47 came back 200 with reasoningTokens=0.
            reasoningEffort: 'high',
        },
        credentialField: 'awsBearerToken' as const,
        // NO reasoning assertion, for a reason this transport cannot work
        // around: on Bedrock, reasoning TEXT is the only evidence available.
        // `TokenUsage` in the Converse API carries inputTokens, outputTokens,
        // totalTokens and the two cache counts — there is no thinking-token
        // field to fall back on (AWS API reference, TokenUsage), which is why
        // `@ai-sdk/amazon-bedrock` hardcodes `outputTokens.reasoning = void 0`
        // and every Bedrock row here reads 0.
        //
        // And from Opus 4.7 the text is empty by default: `thinking.display`
        // flipped from `summarized` to `omitted` with that generation
        // (@ai-sdk/anthropic schema, "default for Opus 4.7+"). Claude still
        // reasons and is still billed for it — Anthropic's pricing table says
        // the billed count is identical under both settings — the response
        // just carries empty thinking blocks.
        //
        // Measured together on 2026-09-23, same effort, prompt and key:
        //     amazon_bedrock (sonnet-4-6)  tokens=0  textChars=54
        //     bedrock_opus47 (opus-4-7)    tokens=0  textChars=0
        //
        // The raw `usage` from that run settles what those zeros mean, because
        // `amazon_bedrock` and the native `anthropic` row are the SAME model at
        // the SAME effort over two transports — `us.anthropic.claude-sonnet-4-6`
        // and `claude-sonnet-4-6`:
        //
        //     native   in 40  out 58  ->  text  8  +  reasoning 50
        //     bedrock  in 40  out 58  ->  text 58  +  reasoning absent
        //
        // Identical totals. Bedrock generated the same ~50 reasoning tokens and
        // billed them; only the split is missing, and `text 58` is not evidence
        // of 58 text tokens — `@ai-sdk/amazon-bedrock` copies the output total
        // into `text` on the same line where it hardcodes `reasoning` away
        // (dist/index.js:455), so that field carries no information at all.
        //
        // So the cost is visible on Bedrock and the composition is not. Every
        // Bedrock reasoning number this repo reports is a floor of zero over a
        // real spend, and per-model cost attribution splits it wrong by exactly
        // the reasoning share. The gap is the transport's, not ours, but the
        // wrong number is ours to stop publishing.
        //
        // So `reasons: true` here asserts something no request we send can
        // observe. Asking for `display: 'summarized'` would restore it, but
        // that is a PRODUCTION change — the returned text enters the message
        // history, `sendReasoning` defaults true, and the compressor only
        // truncates `tool` turns — so it belongs in its own change with its
        // own measurement, not smuggled in through a contract row.
        //
        // What the row still earns its keep for: 4.7+ REJECTS budgetTokens,
        // so a regression to the legacy shape is a hard 400 and turns this
        // red. That is what it guards.
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
        // Same class as the gpt-5.6 rows: an effort a customer configured that
        // reaches no parameter. Marked so the log stops reading it as covered.
        knownGap: true,
        reasons: false,
    },

    // ── Vertex: a whole PROVIDER with no live row. `libs/llm/providers/vertex`
    // builds TWO different SDK models from one provider id and resolves their
    // reasoning through two different modules — Claude-on-Vertex speaks the
    // Anthropic thinking protocol (PR #1303 exists because it did not), Gemini-
    // on-Vertex speaks google thinkingConfig. Both claims are offline today.
    //
    // The credential is the service account JSON, base64, in `apiKey` — the
    // provider decodes it itself (`vertexModelFromSaJson`), so this needs no
    // `credentialField` and no new mechanism, just the secret.
    {
        brand: 'google_vertex',
        // GATED OFF, and the gate is the point. The Vertex credential IS in CI,
        // so without this the three Claude rows would run every Monday and fail
        // every Monday on a GCP quota grant we do not currently hold — the
        // red-every-week alarm this whole file is built to avoid.
        //
        // This gate is a DEBT, not a finding that the coverage is unnecessary.
        // Self-hosted customers run Claude on Vertex today and no live call has
        // ever checked what we send them. Set BYOK_VERTEX_CLAUDE=1 on a project
        // that holds the quota and all three wake up — that is the whole fix.
        // The Gemini row below stays live: it passes.
        requires: () => !!process.env.BYOK_VERTEX_CLAUDE,
        // NOT yet verified against a live vendor, and the reason is a GCP quota
        // grant rather than anything in our code. Walked the whole path on
        // 2026-09-17, on a project with billing enabled, roles/aiplatform.user
        // bound, and all three Claude models accepted in Model Garden:
        //
        //   global    -> 429 RESOURCE_EXHAUSTED
        //                "Quota exceeded for aiplatform.googleapis.com/
        //                 global_online_prediction_requests_per_base_model
        //                 with base model: anthropic-claude-sonnet"
        //   us-east5  -> 404 Not Found (that host serves an older catalogue —
        //                claude-3-opus and claude-sonnet-4-5 and nothing newer)
        //
        // Model Garden acceptance is NOT the blocker — with it missing the
        // answer is 403 PERMISSION_DENIED, and this is 429. Acceptance and quota
        // are two separate grants, and the self-service quota page offers a
        // range of "0 to 0" on a project with no usage history: "não é possível
        // aumentar a cota no momento ... entre em contato com nossa equipe de
        // vendas". So these rows need a GCP project that ALREADY runs Vertex,
        // not another form. The row stays on `global`, the route that answers.
        why: 'Claude-on-Vertex resolves reasoning through the ANTHROPIC module, not google thinkingConfig — the whole reason PR #1303 exists. Nothing has ever called it',
        slot: {
            provider: 'google_vertex',
            model: 'claude-sonnet-4-6',
            vertexLocation: 'global',
            reasoningEffort: 'medium',
        },
        reasons: true,
    },
    // The Vertex rows are one per SHAPE, not one per model — the id only selects
    // a band in `resolveAnthropicModelTraits`, and two models in the same band
    // produce the same request. Measured, not assumed:
    //
    //   claude-sonnet-4-6   adaptive-4-6   thinkingShape=adaptive  (row above)
    //   claude-sonnet-5     modern         thinkingShape=adaptive
    //   claude-haiku-4-5    legacy         thinkingShape=budget
    //
    // `claude-opus-5` resolves to `modern` exactly like `claude-sonnet-5`, so a
    // row for each would run the same code twice. Sonnet is the cheaper of the
    // two and the native tier already carries an Opus 5 row.
    //
    // AND THE CORPUS CANNOT SETTLE WHO RUNS VERTEX. `byok-prod-shapes.json` is
    // built from the CLOUD replica (`$PROD_REPLICA_URL`); a self-hosted install
    // keeps its own database and never appears there. Zero Vertex slots in it
    // means zero CLOUD slots and nothing more — self-hosted customers DO run
    // Claude on Vertex, and every claim this provider makes about them (the
    // band, the thinking shape, the temperature policy) rests on offline tables
    // no live call has ever checked.
    {
        brand: 'google_vertex_modern',
        // GATED OFF, and the gate is the point. The Vertex credential IS in CI,
        // so without this the three Claude rows would run every Monday and fail
        // every Monday on a GCP quota grant we do not currently hold — the
        // red-every-week alarm this whole file is built to avoid.
        //
        // This gate is a DEBT, not a finding that the coverage is unnecessary.
        // Self-hosted customers run Claude on Vertex today and no live call has
        // ever checked what we send them. Set BYOK_VERTEX_CLAUDE=1 on a project
        // that holds the quota and all three wake up — that is the whole fix.
        // The Gemini row below stays live: it passes.
        requires: () => !!process.env.BYOK_VERTEX_CLAUDE,
        // THE TEMPERATURE IS THE SUBJECT, and without it this row is redundant.
        // Checked before writing it: `reasoning()` on Vertex returns the SAME
        // body for both bands —
        //   claude-sonnet-4-6  {thinking:{type:adaptive}, effort:medium}
        //   claude-sonnet-5    {thinking:{type:adaptive}, effort:medium}
        // so a second row asserting the thinking shape would run the row above
        // again under a different name. Where they actually diverge is sampling:
        //   temperaturePolicy(claude-sonnet-4-6) -> adjustable
        //   temperaturePolicy(claude-sonnet-5)   -> unsupported
        // On the 4.7+/5 line a temperature that reaches the wire is a 400, and
        // the SDK only strips it by itself while thinking is ON. So the slot
        // carries one the runtime must DROP — if it ever leaks, this row is
        // where that shows, exactly as `openai_compatible_gpt5` does one tier up.
        why: 'the `modern` band over Vertex, where temperature is UNSUPPORTED while the 4.6 row above takes it — the one place the two bands produce different requests. The slot carries a temperature the Vertex path must drop',
        slot: {
            provider: 'google_vertex',
            model: 'claude-sonnet-5',
            vertexLocation: 'global',
            reasoningEffort: 'medium',
            temperature: 0.2,
        },
        reasons: true,
    },
    {
        brand: 'google_vertex_legacy',
        // GATED OFF, and the gate is the point. The Vertex credential IS in CI,
        // so without this the three Claude rows would run every Monday and fail
        // every Monday on a GCP quota grant we do not currently hold — the
        // red-every-week alarm this whole file is built to avoid.
        //
        // This gate is a DEBT, not a finding that the coverage is unnecessary.
        // Self-hosted customers run Claude on Vertex today and no live call has
        // ever checked what we send them. Set BYOK_VERTEX_CLAUDE=1 on a project
        // that holds the quota and all three wake up — that is the whole fix.
        // The Gemini row below stays live: it passes.
        requires: () => !!process.env.BYOK_VERTEX_CLAUDE,
        // `low` AND a cap of its own, because the budget shape states its
        // ceiling out loud and the protocol requires max_tokens above it:
        //   low 5,000 · medium 15,000 · high 40,000
        // At the default 4,096 cap this row would have gone out with a budget
        // larger than its own ceiling and been rejected — a 400 that says
        // nothing about Vertex. `low` is safe here in a way it is not on an
        // adaptive row: the budget is explicit, so the model is told to think
        // rather than left to decide it needn't.
        maxOutputTokens: 6_144,
        why: 'the `legacy` budget shape — thinking {type:enabled, budget_tokens} — which has NO live row in any provider today. Haiku 4.5 is the only current model that still resolves to it, so this is the one place that shape reaches a real vendor',
        slot: {
            provider: 'google_vertex',
            model: 'claude-haiku-4-5',
            vertexLocation: 'global',
            reasoningEffort: 'low',
        },
        reasons: true,
    },
    {
        brand: 'google_vertex_gemini',
        // VERIFIED LIVE 2026-09-17: 346-366 reasoning tokens across three runs,
        // so the google thinkingConfig path on Vertex is real and this row
        // measures it rather than asserting it.
        why: 'the OTHER SDK model behind the same provider id: Gemini-on-Vertex takes google thinkingConfig, and a shared provider that builds two transports can regress on one of them alone',
        slot: {
            provider: 'google_vertex',
            model: 'gemini-3.1-pro-preview',
            vertexLocation: 'global',
            reasoningEffort: 'medium',
        },
        reasons: true,
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
    ...kodusCatalogRows(),
    {
        brand: 'moonshot_code',
        why: 'k2.7-code is the pair to the k2.6 row and differs on BOTH facts we changed: thinking cannot be disabled, and platform.kimi.ai documents its temperature as not modifiable. The slot deliberately carries a temperature the runtime must DROP — if it ever reaches the wire this row is where that shows',
        slot: {
            provider: 'openai_compatible',
            model: 'kimi-k2.7-code',
            baseURL: 'https://api.moonshot.ai/v1',
            reasoningEffort: 'medium', // prod: 8 de 15 slots usam medium; 4 high
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
        // The probe fakes every row's credential so it can read the request.
        // Most rows take theirs in the slot; the Kodus rows take the PLATFORM
        // key from env at build time, so faking `apiKey` alone left the module
        // refusing to build and the probe measuring nothing — which it reports,
        // correctly, as a row with no ceiling.
        const PLATFORM_KEY = 'API_KODUS_PROVIDER_FIREWORKS_API_KEY';
        const platformKeyBefore = process.env[PLATFORM_KEY];
        process.env[PLATFORM_KEY] ||= 'budget-probe';
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
                        messages: [{ role: 'user', content: 'A train leaves at 14:35 and the trip takes 2h47m. What time does it arrive? Reply with only HH:MM.' }],
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
            if (platformKeyBefore === undefined) delete process.env[PLATFORM_KEY];
            else process.env[PLATFORM_KEY] = platformKeyBefore;
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
        //
        // 45_000, raised from 30_000, and the reason is written here because the
        // comment above says raising it has to be deliberate.
        //
        // `anthropic_compatible` (k3) is the one row over 30k: the Anthropic
        // protocol adds a thinking BUDGET on top of the declared cap, and that
        // budget scales with effort — 5,000 at `low`, 40,000 at `high`. The row
        // ran at `low` only because a test author picked it; both k3 slots in
        // production run `high`, so `low` was testing a configuration no
        // customer has. Fidelity to the stored config is the whole point of
        // this tier, so the effort follows production and the ceiling follows
        // the effort.
        //
        // Authorised, not spent: the prompt is one multiplication. Worst case
        // for the run is about $1.56 at catalog prices, once a week.
        for (const [brand, cap] of perRow) {
            expect([brand, cap]).toEqual([brand, expect.any(Number)]);
            expect(cap).toBeLessThanOrEqual(45_000);
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

    /**
     * The weekly cron string is written THREE times — once in `on.schedule`,
     * once in the daily job's `if` (to stand down on that day) and once in this
     * job's `if` (to stand up). Nothing connected them, and they are exactly the
     * kind of constant that gets edited in one place: move the day in the
     * schedule alone and the weekly run fires with BOTH jobs disabled, which
     * reports green having run nothing at all.
     */
    it('the weekly cron agrees across the schedule and both job gates', () => {
        const workflow = readFileSync(
            join(__dirname, '..', '..', '.github', 'workflows', 'contract-tests.yml'),
            'utf8',
        );
        const crons = [...workflow.matchAll(/^\s+- cron:\s*"([^"]+)"/gm)].map(
            (m) => m[1],
        );
        // The daily tier is the `* * *` one; the other is the weekly BYOK cron.
        const weekly = crons.filter((c) => !/\*\s+\*\s+\*$/.test(c));
        expect(weekly).toHaveLength(1);

        const standsDown = workflow.match(
            /if:\s*github\.event\.schedule\s*!=\s*'([^']+)'/,
        )?.[1];
        const standsUp = workflow.match(
            /github\.event\.schedule\s*==\s*'([^']+)'/,
        )?.[1];

        expect([weekly[0], standsDown, standsUp]).toEqual([
            weekly[0],
            weekly[0],
            weekly[0],
        ]);
    });

    it('reports which brands this run actually covered', () => {
        const covered = configured.map((c) => c.brand);
        // Two reasons a row sits out, and they mean opposite things. "No
        // credential" is a secret someone can go set; "gated off" is a row
        // deliberately parked behind a flag because the blocker is outside this
        // repo. Reporting both as the first sends people hunting for a key that
        // is already there — the Vertex rows hold a working service account and
        // wait on a GCP quota grant.
        const gated = LIVE.filter(
            (c) => (c as { requires?: () => boolean }).requires?.() === false,
        ).map((c) => c.brand);
        const gatedSet = new Set(gated);
        // Rows that RAN and passed while pinning a degraded upstream. Green for
        // them means "the gap is still exactly as documented", never "this works".
        const knownGaps = LIVE.filter(
            (c) => (c as { knownGap?: boolean }).knownGap === true,
        ).map((c) => c.brand);
        const skipped = LIVE.filter(
            (c) => !canRun(c) && !gatedSet.has(c.brand),
        ).map((c) => c.brand);
        // Coverage is DATA, not a failure: a PARTIAL secret is a legitimate
        // green, and so is a fork PR with none. Printing it stops "green" from
        // being mistaken for "everything was checked".
        // eslint-disable-next-line no-console
        console.log(
            `[byok-live] covered: ${covered.join(', ') || '(none)'}\n` +
                `[byok-live] skipped (no credential): ${skipped.join(', ') || '(none)'}\n` +
                `[byok-live] gated off (blocker outside this repo): ${gated.join(', ') || '(none)'}\n` +
                `[byok-live] known gap (effort configured upstream, no reasoning billed): ${knownGaps.join(', ') || '(none)'}`,
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

    /**
     * The classifier itself, offline — because the failure it renames only
     * happens on a Monday with a dead secret, and a helper that is only
     * exercised then is a helper nobody knows is broken.
     */
    it('names a dead credential as a credential failure, not drift', async () => {
        await expect(
            onlyDrift('anthropic', Promise.reject(new Error('API key is invalid.'))),
        ).rejects.toThrow(/CREDENTIAL failure, NOT provider drift/);
        await expect(
            onlyDrift('bedrock_opus47', Promise.reject(new Error('Forbidden'))),
        ).rejects.toThrow(/CREDENTIAL failure/);
        await expect(
            onlyDrift(
                'openai_compatible_claude',
                Promise.reject(new Error('Invalid Anthropic API Key')),
            ),
        ).rejects.toThrow(/CREDENTIAL failure/);
        await expect(
            onlyDrift(
                'amazon_bedrock',
                Promise.reject(
                    new Error('Model access is denied due to INVALID_PAYMENT_INSTRUMENT'),
                ),
            ),
        ).rejects.toThrow(/CREDENTIAL failure/);

        // Observed locally on 2026-09-17 with a revoked service-account key —
        // OpenAI says "incorrect", not "invalid", and the first cut of the
        // regex let this one through as drift.
        await expect(
            onlyDrift(
                'openai_gpt56',
                Promise.reject(
                    new Error(
                        'Incorrect API key provided: sk-svcac****. You can find your API key at https://platform.openai.com/account/api-keys.',
                    ),
                ),
            ),
        ).rejects.toThrow(/CREDENTIAL failure/);

        // Observed live on 2026-09-17 against project kody-408918: GCP denies a
        // delinquent project before the model ever sees the request.
        await expect(
            onlyDrift(
                'google_vertex_gemini',
                Promise.reject(
                    new Error(
                        'Lightning dunning decision is deny for project: projects/39158519179',
                    ),
                ),
            ),
        ).rejects.toThrow(/CREDENTIAL failure/);

        // The vendor's own words survive — the rename adds a cause, it does not
        // swallow the evidence.
        await expect(
            onlyDrift('anthropic', Promise.reject(new Error('API key is invalid.'))),
        ).rejects.toThrow(/Provider said: API key is invalid\./);

        // ...and real drift still reads as itself. A classifier that caught
        // everything would relabel the very failure this tier exists to find.
        await expect(
            onlyDrift('zai', Promise.reject(new Error('unknown field `thinking`'))),
        ).rejects.toThrow(/unknown field `thinking`/);
        await expect(
            onlyDrift('zai', Promise.reject(new Error('unknown field `thinking`'))),
        ).rejects.not.toThrow(/CREDENTIAL failure/);
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
                const result = await onlyDrift(c.brand, LLM.run({
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
                            // Cheap on purpose — the subject under test is the
                            // REQUEST shape, not the answer — but NOT trivial,
                            // and that distinction cost a run to learn.
                            //
                            // This used to ask for the single word "ok". AWS
                            // documents adaptive effort as `medium` "may skip
                            // thinking for very simple queries" and `low`
                            // "skips thinking for simple tasks". Production
                            // configures these models at medium/high, so the
                            // rows carry medium/high — and on a one-word prompt
                            // a model behaving exactly as documented returns
                            // ZERO reasoning tokens, failing `reasons: true`
                            // for a non-regression. Proven live: bedrock_opus47
                            // answered 200 with reasoningTokens=0.
                            //
                            // The effort belongs to the customer's config and
                            // is not ours to lower; the prompt is ours, so the
                            // prompt is what moves. `17 * 23` was the first
                            // attempt and was still too easy: adaptive Claude at
                            // `medium` returned zero reasoning tokens for it.
                            // Two carries over a time boundary is the smallest
                            // thing measured to make it think — and if a model
                            // still reports none here, that is a fact about the
                            // customer's configuration, not a test to bend.
                            content: 'A train leaves at 14:35 and the trip takes 2h47m. What time does it arrive? Reply with only HH:MM.',
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
                }));

                expect(typeof result.text).toBe('string');

                // Raw usage for EVERY row, asserted on or not. It was added to
                // settle two questions that could not be answered offline, and
                // the first run it saw answered both:
                //
                //   - Converse passes NO thinking count. Not through the
                //     catchall either: `amazon_bedrock` came back with
                //     `outputTokenDetails: {textTokens: 58}` and no reasoning
                //     key, against `text 8 + reasoning 50` from the same model
                //     at the same effort natively. The count is gone at the
                //     transport, not dropped by the SDK's `void 0`.
                //   - Whether Anthropic's `thinking_tokens` survives
                //     `display: 'omitted'` is still open, and the reason is on
                //     the `anthropic-modern` row: that request generated no
                //     reasoning at all, so there was no count to survive.
                //
                // It stays because the pair of numbers only means something
                // side by side: a single row's zero reads as "did not think"
                // and as "cannot see it" equally well, and the only thing that
                // told them apart here was another transport's total for the
                // same model. Keep printing it for every brand, including the
                // ones that assert nothing.
                //
                // eslint-disable-next-line no-console
                console.log(
                    `[byok-live-usage] ${c.brand}: ${JSON.stringify(result.usage)}`,
                );

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
 *                      forced tool_choice.
 *                      NO LIVE ROW covers this: the only model that needed it
 *                      (k3 over the Anthropic protocol) is served from
 *                      api.kimi.com/coding, which answers Unauthorized for the
 *                      same key api.moonshot.ai accepts — a separate coding-plan
 *                      subscription, not a credential we hold. The plan is still
 *                      selected in production, so this is a real gap.
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
                const result = await onlyDrift(
                    c.brand,
                    LLM.run({
                        byokConfig: {
                            ...c.slot,
                            apiKey,
                        } as unknown as NormalizedModel,
                        user: 'Reply with ok=true and word="ok".',
                        runName: 'byok-live-structured',
                        schema,
                        maxOutputTokens: 4_096,
                    }),
                );

                // Getting a parsed object back means the whole composition held:
                // the plan picked a channel the model accepts, the schema
                // survived the wire, and the envelope parsed.
                expect(schema.safeParse(result).success).toBe(true);
            },
            120_000,
        );
    }
});
