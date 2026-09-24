/**
 * code-review (domain) — MICRO-AGENTS: one narrow pass per class of defect,
 * instead of one pass carrying every class at once.
 *
 * The generalist prompt puts 34 detection items in front of a single agent and
 * asks it to find all of them. Measured on the 30-PR light set, that agent
 * finds ~30% of the golden comments, and every attempt to add a SECOND broad
 * pass (scout, plan+shard, a reordered replica) landed on the same findings:
 * generalist and shard alone score 29.5% each, together 32.6%, and 74% of the
 * union is found by both. Breadth is what repeats.
 *
 * So the split here is by class, not by passes over the same brief. Each agent
 * carries 1-4 items and nothing else — no Workflow, no CoverageContract, no
 * Rules, no definitions of the other eleven classes. The prompt is ~1.2k of
 * instruction against the ~58k a shard worker inherited.
 *
 * Grouping is by INVESTIGATION METHOD, not by the bug/performance/security
 * taxonomy: `Duplicate operations` ships under bug today but is found the same
 * way as N+1, so it sits with the performance-shaped group. Four items are new,
 * written from the golden comments no configuration has ever found — contract
 * changes the caller did not follow, two sites that must agree and don't, index
 * and ordering arithmetic, and missing defenses on a changed entrypoint.
 *
 * Item text is read out of V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT rather than
 * copied, so the two never drift apart.
 */
import { z } from 'zod';
import { LLM } from '@libs/llm/llm';
import type { NormalizedModel } from '@libs/llm/byok-config';
import { V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT } from '@libs/common/utils/codeReview/v2Defaults';

/** The spec requires a system prompt; this is deliberately the whole of it.
 *  Everything a micro-agent needs to know is in its own user prompt, and the
 *  generalist's 21k system prompt would put "review this PR broadly, cover
 *  every file, follow this nine-step workflow" underneath a one-class
 *  assignment — the exact proportion problem that made shard workers re-review
 *  the diff. */
export const MICRO_AGENT_SYSTEM_PROMPT = `You are a specialist code reviewer. You are given one class of defect to look for in one pull request, and the tools to investigate it. Investigate with the tools before deciding, and answer by calling the submitResult tool.`;

export type MicroAgentLabel = 'bug' | 'security' | 'performance';

export interface MicroAgentGroup {
    id: string;
    /** Fixed — the agent only produces findings of its own class, so letting it
     *  choose a label would be letting it leave its assignment. */
    label: MicroAgentLabel;
    /** One line naming the assignment, used in <Role>. */
    assignment: string;
    /** Prefixes of items to pull verbatim from the shared category text. */
    items: string[];
    /** Items that exist only here — written from goldens the current list does
     *  not describe. */
    extraItems?: string[];
    /** Class-specific example for the `reasoning` field, so the agent is shown
     *  the shape of ITS trace rather than a race-condition one. */
    reasoningExample: string;
}

/**
 * Covers BOTH axes of "contract", because the first cut only had one.
 *
 * Measured case: a PR moved anonymous device tagging out of a goroutine so
 * Authenticate now waits on it and denies the request when the new device limit
 * is hit. The golden calls that out — the operation used to be best-effort and
 * non-blocking, and now it can refuse. An agent DID see it ("the PR removes the
 * goroutine and two-minute background timeout and now waits in Authenticate"),
 * but reported the latency rather than the refusal, because the only contract
 * language available to it was about types and signatures. The caller here was
 * updated on purpose, so "find the consumer that was not updated" pointed away
 * from the defect.
 */
const CONTRACT_CHANGE = `- Contract change not followed through: The change altered something callers depend on — a function became asynchronous, a return type became nullable or changed shape, a parameter was added/removed/reordered, a field disappeared from a response, an interface gained a required member. Reconstruct what the symbol looked like BEFORE this change and check every consumer against the new shape. Report the consumer that was not updated, anchoring the finding to the changed line.
  This includes a change to the BEHAVIOUR contract, not only to the type: an operation that was best-effort and now fails the request, work that was asynchronous or fire-and-forget and now blocks the caller, an error that was swallowed and now propagates, a fallback that used to cover a case and no longer does. Reconstruct what the caller could previously count on and name what it loses — reporting only the new cost (latency, an extra query) misses the point when the real change is that the operation can now refuse.`;

const CROSS_REFERENCE = `- Cross-reference inconsistency: Two places that must agree and don't — a metric tagged with one name at emit and another at query, a constant or key written differently at the write site and the read site, a validator checking a different field than the writer sets, arguments passed in one order and consumed in another. Neither side is wrong in isolation; the defect is the disagreement. Compare every pair of sites in this change that share a name, key, tag, or ordering.`;

const INDEX_AND_ORDER = `- Index, slice and ordering assumptions: Boundary arithmetic on substrings, slices, ranges and pagination whose indices do not match the layout the code describes; comparisons whose extracted segment is off by one or inverted; code that assumes an iteration, lookup or zip preserves input order when the structure gives no such guarantee (dict/map values, concurrent results, unordered collections). Verify the arithmetic against a concrete example and check whether the ordering is actually guaranteed.`;

const MISSING_DEFENSES = `- Missing defensive measures: a changed or newly added entrypoint that lacks the protection its siblings have — CSRF token check, rate limit, or an authorization guard. Compare against how the neighbouring routes or handlers in the same file are protected.`;

/** 6 goldens — the largest single class among the ones no configuration has
 *  ever found. The name, the comment and the docstring are part of the change
 *  under review; a reviewer who only reads the statements cannot see that the
 *  function no longer does what it is called. */
const NAME_DOC_MISMATCH = `- Name and documentation mismatch: an identifier, comment, docstring, error message or changelog entry that this change made untrue — a function renamed but still described by the old comment, a flag whose name states the opposite of what it now controls, a parameter documented with a default the code no longer uses, a doc block describing a return shape the function stopped producing. The name and the prose are part of the contract a caller reads; report the disagreement between them and the code, anchored to the changed line.`;

/** Was already a RULE in <Rules> ("Concrete findings include build-time and
 *  contract failures too") but never a detection item, so nothing directed an
 *  agent to go look for one. */
const BUILD_TIME_FAILURE = `- Build-time failure: the change does not compile, type-check, lint under the repo's configured rules, or resolve at build time — a symbol imported but not exported, a type argument that no longer satisfies its constraint, a required generated artifact not regenerated alongside the schema it mirrors, a dependency used but absent from the manifest. Confirm with grep or by reading the definition before reporting: a symbol you did not find is not the same as a symbol that does not exist.`;

const FRAMEWORK_CONTRACT = `- Framework or platform contract violated: the code is legal on its own but breaks a rule of the framework, runtime or platform it runs under — a hook called conditionally, a lifecycle method that must be idempotent and is not, a handler that must return before a timeout, a migration that is not reversible, an API called outside the context it requires, an ORM relation loaded outside its session. Name the specific rule of the framework and the line that breaks it.`;

/**
 * The fifteenth class, and the only one whose subject is the test file itself.
 *
 * Written from measurement, and from a wrong assumption corrected: test files
 * are NOT excluded from the corpus. 20% of the full diff is test code (148 of
 * 757 files) and it has been in the prompt since the full-diff fix. What was
 * missing is an item: none of the 34 in v2Defaults describes a defect in a
 * test, so an agent reading test_consumer.py has nothing to match against and
 * moves on. Seven goldens in the light set are about test code and six were
 * missed by the fourteen agents, including a sleep that cannot wait because
 * time.sleep was monkeypatched three lines above it.
 *
 * The whole class reduces to one falsification question, which is why the item
 * leads with it: if the bug this test is named after came back, would this test
 * fail? Everything else is a way the answer turns out to be no. The narrow
 * framing is deliberate — "is this test good" has no end, "would it fail" has
 * an answer.
 */
const TEST_DOES_NOT_VERIFY = `- Test that does not verify what it claims: a test whose body would still pass if the behaviour it names were broken. Ask the falsification question on every test file this PR touches — if the defect this test exists to catch were reintroduced, would this test fail? Report it when the answer is no. The ways that answer turns out to be no:
  - It exercises the wrong target: a different HTTP verb, route, method or overload than the code under test handles; an argument order, fixture or payload that never reaches the branch the test is named after.
  - The assertion is too loose to fail: catching a base exception where the code raises a specific subclass, asserting truthiness or non-null on something that is always set, comparing a value against itself, or an assertion placed after an early return.
  - A mock, patch or fixture neutralises the thing under test: time.sleep patched out and then relied on to wait, the function under test stubbed by an autouse fixture, a spy asserted against instead of the real effect.
  - It synchronises on time instead of on a condition: a fixed sleep, a deadline, or an assertion that fires before the thread, process or async task it is about has finished. It passes on a fast machine and races on a slow one.
  - The name or docstring disagrees with the body: a case called empty_array that passes an empty dict, a typo in the test name that hides it from a name-filtered run, a docstring describing an assertion the body does not make.
  Read the test against the implementation it covers, never on its own — the defect is almost always the disagreement between the two.`;

const I18N_LOCALE = `- Localisation and user-facing content: a string shown to a user that bypasses the translation mechanism the surrounding code uses, an interpolation whose placeholders do not match the keys the translators receive, a locale file changed on one side only, a format (date, number, currency, pluralisation) hard-coded to one locale, or content that stops being escaped on its way to the user. Compare against how the neighbouring strings in the same file are handled.`;

/** The five extensions below widen an item that ALREADY exists in v2Defaults
 *  rather than adding a class. Each was written from a golden the current
 *  wording came close to and missed by one sentence. They live here, next to
 *  the group that carries the item, until the port into v2Defaults — which
 *  would also give the generalist, the shard and the scout access to them. */
const DEAD_COMPUTATION_EXT = `- Dead computation (extended): the existing item covers a value computed and then not used. It also covers TWO NEARLY IDENTICAL NAMES IN THE SAME SCOPE where the code goes on using the original instead of the enriched or transformed one (\`log\` vs \`d.Log\`, \`ctx\` vs \`reqCtx\`), and it covers A BRANCH THAT CANNOT EXECUTE — an \`else if\` whose condition is already excluded by the branch above it, or a final \`else\` made unreachable because the function it tests never returns that value. Trace the assignment and the branch conditions rather than reading them as written.`;

const WRONG_RESULTS_EXT = `- Wrong results (extended): the error code, the HTTP status and the message text are OUTPUT, exactly like a returned value. A handler that answers 404 where the resource exists but the caller lacks permission, a message naming a different field than the one that failed validation, or a code that tells the client to retry something that can never succeed are all wrong results, even when the happy path is correct.`;

const EXECUTION_BREAKS_EXT = `- Execution breaks (extended): the SERIALISATION BOUNDARY is where a value that was fine in memory raises — a datetime, Decimal, set, or custom object placed into a payload that will be JSON-encoded, a field that becomes NaN or Infinity, a type the queue's encoder has no rule for. The exception surfaces at the encode call, not at the line that produced the value, so check what happens to every new field on its way out.`;

const STATE_CORRUPTION_EXT = `- State corruption (extended): a CACHE is state, and it corrupts the same way — an error result, an empty fallback or a partially built object written into the cache under the key of the real answer, so every later reader is served the failure. Check what gets stored on the failure path, not only on the success path.`;


const MICRO_AGENTS_TODOS: MicroAgentGroup[] = [
    {
        id: 'untrusted-input-sink',
        label: 'security',
        assignment:
            'user-controlled values reaching a sink without validation',
        items: [
            'Injection vulnerabilities',
            'SSRF (Server-Side Request Forgery)',
            'Input validation gaps',
            'Input validation bypass',
        ],
        reasoningExample:
            "Traced the `sort` query param into the ORDER BY built at repo.ts:88. Grepped for other callers of buildOrderBy(, found one at list.ts:31 passing a validated enum. The new path concatenates the raw value. Reported.",
    },
    {
        id: 'secret-and-identity',
        label: 'security',
        assignment:
            'comparisons, normalisation and derivation involving secrets or identity',
        items: [
            'Timing attacks',
            'Case-sensitivity bypass',
            'Crypto issues',
            'Insecure fallback values',
        ],
        reasoningExample:
            "The new token check at auth.ts:40 compares with ===. Read the surrounding helper: no constant-time path anywhere in the file. The old code used timingSafeEqual, removed in this diff. Reported.",
    },
    {
        id: 'authorization',
        label: 'security',
        assignment:
            'who can reach a changed entrypoint, with what credential, and for how long',
        items: ['AuthZ/AuthN flaws', 'Session management'],
        extraItems: [MISSING_DEFENSES],
        reasoningExample:
            "The new DELETE route at router.ts:22 has no guard. Read the two neighbouring routes: both call requireOwner() before the handler. Nothing in the diff adds it here. Reported.",
    },
    {
        id: 'data-exposure',
        label: 'security',
        assignment:
            'what leaves in the response, the log and the error message',
        items: ['Data exposure'],
        reasoningExample:
            "The new catch block at service.ts:77 logs the whole request object, which carries the Authorization header set at middleware.ts:14. Reported.",
    },
    {
        id: 'capture-and-evaluation',
        label: 'bug',
        assignment:
            'when a value was evaluated and what it became before it was used',
        items: [
            'Mutable default arguments',
            'Closure capturing mutable references',
            'Async timing bugs',
        ],
        reasoningExample:
            "The handlers built in the loop at setup.ts:30 all close over `cfg`, which is reassigned at line 44 before any of them runs. Read the call site: they fire after setup completes, so all three see the last value. Reported.",
    },
    {
        id: 'value-boundary-and-position',
        label: 'bug',
        assignment:
            'what the code assumes about a value at its boundaries and positions',
        items: [
            'Conditional validation errors',
            'Floating-point equality in critical operations',
        ],
        extraItems: [INDEX_AND_ORDER],
        reasoningExample:
            "The prefix check at token.ts:61 reads substring(4,6), but the comment and the writer at token.ts:20 place the shortcut at indices 5-6. Worked through 'abc:XY1234': the check compares the wrong two characters. Reported.",
    },
    {
        id: 'resource-and-growth',
        label: 'bug',
        assignment:
            'resources that are opened and not closed, and collections that grow without a bound',
        items: ['Resource leaks', 'Unbounded growth', 'Memory waste'],
        reasoningExample:
            "The stream opened at import.ts:55 is closed only on the success path; the new early return at line 62 skips it. Reported.",
    },
    {
        id: 'repeated-work',
        label: 'performance',
        assignment: 'work repeated once per processed item',
        items: [
            'Database inefficiency',
            'Duplicate operations',
            'Redundant operations',
            'Cache misses',
        ],
        reasoningExample:
            "The loop at list.ts:40 calls findUser() per row. Read findUser: one query each, no batching, and the cache added in this diff is keyed per request so it never hits across rows. N queries for N rows. Reported.",
    },
    {
        id: 'scale-and-blocking',
        label: 'performance',
        assignment: 'what happens as n grows, and who waits while it does',
        items: [
            'Algorithm complexity',
            'Blocking operations',
            'Batch processing inefficiency',
        ],
        reasoningExample:
            "The new dedup at merge.ts:18 does indexOf inside the loop over the same array — quadratic in the number of items, and the caller at job.ts:90 passes the full unpaged result. Reported.",
    },
    {
        id: 'invalid-state-and-concurrency',
        label: 'bug',
        assignment:
            'the declared constraint and the path that breaks it, including interleaving',
        items: [
            'Execution breaks',
            'State corruption',
            'Invariant violations',
            'Race conditions',
        ],
        extraItems: [EXECUTION_BREAKS_EXT, STATE_CORRUPTION_EXT],
        reasoningExample:
            "CreateDevice counts then inserts. Grepped TagDevice(, found the caller at impl.go:155. Two concurrent requests both pass the count check before either inserts, and there is no unique constraint. Reported.",
    },
    {
        id: 'says-one-thing-does-another',
        label: 'bug',
        assignment:
            'what the code declares, measures or names versus what it actually uses',
        // `Wrong results` and `Logic errors` belonged to no group at all: the
        // twelve agents covered 32 of the 34 items in v2Defaults, so the
        // micro-agent config was blind to two classes the generalist carries —
        // which biased every generalist-vs-micro comparison measured so far.
        items: [
            'Dead computation',
            'Incorrect measurements',
            'Wrong results',
            'Logic errors',
        ],
        extraItems: [
            CROSS_REFERENCE,
            DEAD_COMPUTATION_EXT,
            WRONG_RESULTS_EXT,
        ],
        reasoningExample:
            "The metric is emitted with the tag 'shard' at writer.go:31 and queried with 'shards' at dashboard.go:12 — both added in this diff. The panel will read nothing. Reported.",
    },
    {
        id: 'contract-not-followed',
        label: 'bug',
        assignment:
            'a changed contract that a consumer was not updated to match',
        items: [],
        extraItems: [CONTRACT_CHANGE],
        reasoningExample:
            "findMembers() gained async in this diff. Grepped findMembers(, found controller.ts:48 using the result directly with no await — it now holds a Promise. Reported, anchored to the changed signature.",
    },
    {
        // Sibling of `contract-not-followed`: that one checks the contract with
        // a consumer inside the repo, this one the contract with something
        // outside it — the compiler, the framework, the platform. Same method
        // (reconstruct what was expected, confront the change with it),
        // different counterparty.
        id: 'contract-with-the-platform',
        label: 'bug',
        assignment:
            'a rule of the compiler, framework or platform that this change breaks',
        items: [],
        extraItems: [BUILD_TIME_FAILURE, FRAMEWORK_CONTRACT],
        reasoningExample:
            "useSyncState is called inside the `if (ready)` added at panel.tsx:40. React requires hooks at the top level on every render; grepped the file for other hooks and all nine sit above the first conditional. Reported.",
    },
    {
        // Both items are found by reading what a human will see and checking it
        // against what the code does — a method none of the other thirteen use.
        id: 'text-that-ships',
        label: 'bug',
        assignment:
            'text that reaches a person — names, comments, messages, translations — disagreeing with the code',
        items: [],
        extraItems: [NAME_DOC_MISMATCH, I18N_LOCALE],
        reasoningExample:
            "The flag added at config.ts:12 is named disableRetry but the branch at client.ts:88 enables retries when it is true. Read both: the name states the opposite of the behaviour. Reported.",
    },
    {
        id: 'test-does-not-verify',
        label: 'bug',
        assignment:
            'tests changed by this PR that would still pass if the behaviour they cover were broken',
        items: [],
        extraItems: [TEST_DOES_NOT_VERIFY],
        reasoningExample:
            "test_consumer.py waits with time.sleep(1) at line 88, but time.sleep is patched to a no-op by the autouse fixture at line 31. Read both: the wait returns immediately, so the assertion at line 90 runs before the flusher has processed anything and would pass with the flusher removed entirely. Reported.",
    },
];

/**
 * VARIANTE FUNDIDA (opt-in, A/B) — 8 agentes no lugar de 12.
 *
 * A medida que motiva: contando golden EXCLUSIVO (aquele que nenhum outro
 * agente alcanca), seis agentes valem 1 ou 0 nos dois modelos. O
 * `contract-with-the-platform` nao forma par: 83% do que ele alcanca no GPT
 * (82% no DeepSeek) ja e alcancado pelo `invalid-state-and-concurrency`, entao
 * ele sai sem substituto.
 *
 * Os quatro de seguranca viram DOIS, nao um. Juntar os quatro num so misturava
 * "o dado" com "o sujeito", que sao perguntas independentes, e deixava o
 * DetectionFocus com 11 itens — o dobro de qualquer agente atual. A particao
 * saiu da sobreposicao medida de goldens (Jaccard, 30 PRs): no DeepSeek
 * `untrusted-input-sink` e `data-exposure` compartilham 38% e
 * `secret-and-identity` e `authorization` 18%, contra 0% nos cruzamentos; e a
 * particao com mais goldens em comum dentro dos pares (5 contra 2 da
 * alternativa). No GPT a amostra e pequena, mas o unico par com sinal e
 * `secret-and-identity` + `authorization`, com 25%.
 *
 * O que esta em jogo: os quatro de seguranca somam 74 candidatos nos dois
 * modelos para 5 goldens exclusivos, e 40 falsos positivos.
 *
 * REVERSIVEL POR CONSTRUCAO: `MICRO_AGENTS` continua sendo os 12. Esta lista so
 * e usada quando `RECALL_MICRO_FUNDIDOS=1`, e nada em producao a alcanca.
 */
const MICRO_AGENTS_FUNDIDOS: MicroAgentGroup[] = [
    {
        id: 'untrusted-data-path',
        label: 'security',
        assignment:
            'the path of an untrusted value: what enters without validation, and what leaves in the response, the log and the error message',
        items: [
            'Injection vulnerabilities',
            'SSRF (Server-Side Request Forgery)',
            'Input validation gaps',
            'Input validation bypass',
            'Data exposure',
        ],
        reasoningExample:
            "Traced the `sort` query param into the ORDER BY built at repo.ts:88. Grepped for other callers of buildOrderBy(, found one at list.ts:31 passing a validated enum. The new path concatenates the raw value. Reported.",
    },
    {
        id: 'identity-and-access',
        label: 'security',
        assignment:
            'who can reach a changed entrypoint, with what credential and for how long, and how secrets or identity are compared, normalised and derived',
        items: [
            'AuthZ/AuthN flaws',
            'Session management',
            'Timing attacks',
            'Case-sensitivity bypass',
            'Crypto issues',
            'Insecure fallback values',
        ],
        extraItems: [
            '- Missing defensive measures: a changed or newly added entrypoint that lacks the protection its siblings have — CSRF token check, rate limit, or an authorization guard. Compare against how the neighbouring routes or handlers in the same file are protected.',
        ],
        reasoningExample:
            "The new DELETE route at router.ts:22 has no guard. Read the two neighbouring routes: both call requireOwner() before the handler. Nothing in the diff adds one. Reported.",
    },
    {
        id: 'value-in-motion',
        label: 'bug',
        assignment:
            'what a value is at the moment it is used: when it was evaluated, what it became on the way, and what the code assumes about it at its boundaries and positions',
        items: [
            'Mutable default arguments',
            'Closure capturing mutable references',
            'Async timing bugs',
            'Conditional validation errors',
            'Floating-point equality in critical operations',
        ],
        extraItems: [
            '- Index, slice and ordering assumptions: Boundary arithmetic on substrings, slices, ranges and pagination whose indices do not match the layout the code describes; comparisons whose extracted segment is off by one or inverted; code that assumes an iteration, lookup or zip preserves input order when the structure gives no such guarantee (dict/map values, concurrent results, unordered collections). Verify the arithmetic against a concrete example and check whether the ordering is actually guaranteed.',
        ],
        reasoningExample:
            "The prefix check at token.ts:61 reads substring(4,6), but the comment and the writer at token.ts:20 place the shortcut at indices 5-6. Worked through a concrete token: the check reads one char short. Reported.",
    },
];

/** Ids que a fusao absorve. Saem da lista quando a variante esta ligada. */
const ABSORVIDOS_PELA_FUSAO = new Set([
    'untrusted-input-sink',
    'secret-and-identity',
    'authorization',
    'data-exposure',
    'capture-and-evaluation',
    'value-boundary-and-position',
    // sem par: ja coberto em 82-83% pelo invalid-state-and-concurrency
    'contract-with-the-platform',
]);

/**
 * Tres agentes nao rodam mais. Nao e economia de prompt: sobre os 29 PRs do
 * conjunto, nenhum dos tres produziu um unico achado que o reducer mantivesse —
 * tudo que eles geraram ou foi agrupado em cima de um achado de outro agente,
 * ou ficou abaixo da cota. Rodar os tres e pagar geracao para jogar fora.
 *
 * `RECALL_SKIP_AGENTS` acrescenta outros ids a lista (e so acrescenta): serve
 * para varrer qual agente paga, sem recompilar.
 */
const DESLIGADOS_POR_PADRAO = [
    'scale-and-blocking',
    'repeated-work',
    'resource-and-growth',
];

const DESLIGADOS = new Set([
    ...DESLIGADOS_POR_PADRAO,
    ...String(process.env.RECALL_SKIP_AGENTS || '')
        .split(',')
        .map((x) => x.trim().replace(/^micro-/, ''))
        .filter(Boolean),
]);

const BASE: MicroAgentGroup[] = MICRO_AGENTS_TODOS.filter(
    (g) => !DESLIGADOS.has(g.id),
);

/** RECALL_MICRO_FUNDIDOS=1 troca os sete redundantes pelos dois fundidos: 12
 *  agentes viram 8. Desligado por padrao — os 12 continuam sendo o que roda. */
export const MICRO_AGENTS: MicroAgentGroup[] =
    process.env.RECALL_MICRO_FUNDIDOS === '1'
        ? [
              ...BASE.filter((g) => !ABSORVIDOS_PELA_FUSAO.has(g.id)),
              ...MICRO_AGENTS_FUNDIDOS,
          ]
        : BASE;


/** Pulls an item out of the shared category text by its prefix, so the wording
 *  stays in one place. A prefix that stops matching is a loud failure rather
 *  than a silently empty focus block. */
function itemByPrefix(prefix: string): string {
    for (const text of Object.values(V2_DEFAULT_CATEGORY_DESCRIPTIONS_TEXT)) {
        for (const line of String(text).split('\n')) {
            const t = line.trim();
            if (t.startsWith(`- ${prefix}`)) return t;
        }
    }
    throw new Error(
        `micro-agents: no detection item starts with "${prefix}" — it was renamed or removed in v2Defaults`,
    );
}

export function focusBlockFor(group: MicroAgentGroup): string {
    return [...group.items.map(itemByPrefix), ...(group.extraItems ?? [])].join(
        '\n',
    );
}

/**
 * The full prompt for one micro-agent.
 *
 * What is deliberately NOT here: the <Workflow> (its PHASE 2 adversarial
 * questions are a generic restatement of the very categories each agent is
 * meant to specialise in), the <CoverageContract> (it demands coverage of every
 * diff hunk, which is the opposite of a narrow assignment), the tool-discipline
 * rules (kept out on purpose — never measured, and a step budget of 12 is small
 * enough that the traces will show if it was needed), and the definitions of
 * the other eleven classes.
 *
 * What survives is the part with evidence behind it: the stance lines. Removing
 * their equivalents from a shard worker cost 7.4pp of recall, and the failure
 * mode they address is documented — the model writing 17k characters of
 * analysis about the exact symbol a golden names, then reporting nothing.
 */
export function buildMicroAgentPrompt(
    group: MicroAgentGroup,
    diffText: string,
    callGraph?: string,
): string {
    // <Diffs> FIRST, and the assignment after it. The twelve agents run under
    // one Promise.all against the same pull request, so the diff is the only
    // thing all of them send identically — and prefix caching only matches
    // from the start of the message. With <Role> on top, each agent's prompt
    // diverged at byte ~200 and the shared diff was paid in full twelve times
    // over: a measured 10.9M-token run on a 127-file PR read just 831k from
    // cache, 7.6%. The diff there was ~74k tokens against ~1k of instruction,
    // so what the agents share is 98.7% of the prompt and it was sitting
    // behind the 1.3% that differs.
    //
    // NOT yet measured for quality. Putting 74k of diff ahead of the
    // assignment is a real change to what the model reads first, and recency
    // cuts both ways; this needs an A/B on the 30-PR set before it counts as
    // an improvement rather than just a cheaper run.
    // <CallGraph> DEPOIS do diff e ANTES do <Role>: e a segunda coisa que os
    // doze agentes mandam identica, entao fica dentro do prefixo compartilhado
    // e cacheia junto. Posto abaixo do <Role> ele cairia atras do byte em que
    // os prompts divergem e seria pago doze vezes por inteiro.
    //
    // OPT-IN. O blob nunca esteve em nenhuma medicao que temos — nem com o
    // generalista, onde a secao existe mas os datasets nunca definiram o campo.
    // Custo estimado no conjunto de 30 PRs: ~9k chars por PR, +7.7% de input,
    // +5% de conta com o cache funcionando. Efeito em recall e precisao:
    // desconhecido, que e a razao de existir o teste.
    const graphBlock = callGraph?.trim()
        ? `\n${callGraph.trim()}\n`
        : '';

    return `<Diffs>
${diffText}
</Diffs>
${graphBlock}
<Role>
  You are a code reviewer with ONE assignment on this pull request: ${group.assignment}.
  You are not reviewing it broadly — other reviewers cover the rest. Look for the
  class of defect defined below and nothing else. A defect outside that class is
  real, but it is not yours to report.
</Role>

<DetectionFocus>
${focusBlockFor(group)}
</DetectionFocus>

<Stance>
  A change being intentional does not make it correct. Conclude "safe" only after
  a real attempt to break it came up empty — "it looks correct" is not a verdict;
  "I traced X and confirmed Y holds" is.

  Report any defect of your assigned class that the changed code makes you
  suspect; dismiss only what you can explain WHY it cannot fail. Root cause must
  be in lines added or modified by this PR — report a pre-existing issue only if
  this change makes it worse or newly reachable.

  The diff above is the whole pull request. Your assignment is the block above —
  read the diff against it, not broadly.
</Stance>

<OutputFormat>
  Report by calling the submitResult tool with this shape:

\`\`\`json
{
  "reasoning": "REQUIRED, never empty — what you traced and why you reported or dismissed. Example: '${group.reasoningExample}'",
  "suggestions": [
    {
      "label": "${group.label}",
      "relevantFile": "path/to/file.ext",
      "language": "the file language",
      "suggestionContent": "WHAT: one sentence naming the exact problem. WHY: one sentence on the real impact. HOW: concrete fix if clear from the code — omit if speculative.",
      "existingCode": "problematic code snippet from the diff",
      "improvedCode": "fixed code snippet (only if fix is clear from context)",
      "oneSentenceSummary": "Brief summary",
      "reason": "REQUIRED when the schema asks for it — the walk that produced THIS finding, not a restatement of it: the concrete input or state you started from, the lines it passes through in order with file:line, and what the caller ends up with. A reason with no file:line is not one. If you cannot write the walk, you have not established the finding and should not submit it.",
      "relevantLinesStart": 10,
      "relevantLinesEnd": 15,
      "severity": "critical|high|medium|low",
      "confidence": 8
    }
  ]
}
\`\`\`

  Anchor relevantLinesStart/End to the lines this PR changed — that is the fix site.

  Assign confidence honestly:
    9-10: you read BOTH the call site AND the definition, and confirmed the mismatch
    7-8:  you read the relevant code and traced the failure path, but not both sides
    5-6:  the pattern looks wrong from the diff, but you only read one side
    1-4:  speculative, or based on experience rather than on evidence in this repo

  "reasoning" is REQUIRED and is never empty, including when you report nothing:
  name what you read, what you checked it against, and why you concluded the
  change is safe for your class. A submission with an empty reasoning is not a
  verdict — it is an unanswered assignment, and it makes the pass impossible to
  review afterwards.

  If your own analysis concludes a concrete defect is real, it MUST become an
  entry in "suggestions" — writing "reported" in the reasoning without a matching
  entry means the finding is LOST.

  Never claim something is missing, undefined, not imported, or does not exist
  without first using grep to confirm. Never claim a method has the wrong
  signature without first reading its definition.

  Most pull requests contain no defect of any single class. If this one contains
  none of yours, submit an empty suggestions array — that is a valid answer, and
  a forced finding costs more than a silent pass.

  AT MOST TWO. Submit no more than two suggestions, and only the ones you are
  surest of. This is a ceiling, never a quota: zero is the ordinary answer and
  one is common. Do not add a second finding to fill the space — a weak second
  buries the strong first, because the developer reads the list, not the
  ranking. If you found more than two that you are equally sure of, keep the two
  whose failure is most concrete and drop the rest.
</OutputFormat>`;
}

/* ------------------------------------------------------------------------ *
 * PLANNER — decide which of the twelve to run for THIS diff.
 *
 * Running all twelve on every PR is mostly waste: on the first measured PR,
 * nine of them investigated and reported nothing, which is the correct answer
 * for a permission-schema change with no loops, no untrusted input and no
 * concurrency. Those nine still spent their steps and their tokens.
 *
 * The planner reads the diff and returns the subset whose class could plausibly
 * be present. It is deliberately biased toward INCLUDING: a class left out is a
 * class with zero chance of being found, while a class included wrongly costs
 * one short pass that returns empty — the asymmetry is the whole design.
 * ------------------------------------------------------------------------ */

/** Catalogue line per agent — assignment plus the item names, enough to decide
 *  relevance without pasting every full description into the planner prompt. */
function plannerCatalogue(): string {
    return MICRO_AGENTS.map((g) => {
        const names = [
            ...g.items,
            ...(g.extraItems ?? []).map((t) =>
                t.replace(/^- /, '').split(':')[0].trim(),
            ),
        ].join(', ');
        return `  ${g.id}\n     assignment: ${g.assignment}\n     covers: ${names}`;
    }).join('\n\n');
}

export function buildMicroPlannerPrompt(diffText: string): string {
    return `You are routing one pull request to a set of specialist reviewers.
Each specialist looks for exactly one class of defect and nothing else.

Read the diff and decide which specialists have something to look at here. A
specialist is relevant when the changed code contains the KIND of construct its
class lives in — not when you already suspect a defect. You are not reviewing
the code; you are deciding who gets to look at it.

Examples of the judgement: a diff that adds a loop issuing a query per row makes
"repeated-work" relevant whether or not it is actually slow. A diff that only
renames a CSS class makes none of the code-path specialists relevant. A change
to a function's signature or return type makes "contract-not-followed" relevant
even if every caller looks updated.

Bias toward including. A specialist you leave out has no chance of finding
anything; one you include wrongly costs a single short pass that comes back
empty. When a class is plausible, include it.

SPECIALISTS:

${plannerCatalogue()}

DIFF:

${diffText}

Return the ids of the specialists to run, and one short sentence per id saying
what in the diff makes it relevant.`;
}

const PLANNER_SCHEMA = z.object({
    run: z.array(
        z.object({
            id: z.string(),
            why: z.string(),
        }),
    ),
});

export interface MicroPlan {
    groups: MicroAgentGroup[];
    /** Every id the planner returned, including ones that matched no agent —
     *  kept so a drifting id shows up in the trace instead of silently
     *  shrinking the run. */
    requested: string[];
}

/**
 * One-shot, no tools. On ANY failure the plan falls back to all twelve: a
 * planner that errors must not silently turn a full review into a partial one.
 */
export async function runMicroPlanner(
    diffText: string,
    byokConfig: NormalizedModel | undefined,
    organizationId?: string,
    usageRunName?: string,
): Promise<MicroPlan> {
    try {
        const result = await LLM.run({
            byokConfig,
            schema: PLANNER_SCHEMA,
            user: buildMicroPlannerPrompt(diffText),
            runName: usageRunName
                ? `${usageRunName}-micro-planner`
                : 'code-review-micro-planner',
            organizationId,
        });
        const requested = ((result.run as Array<{ id: string }>) ?? [])
            .map((r) => String(r?.id || '').trim())
            .filter(Boolean);
        const byId = new Map(MICRO_AGENTS.map((g) => [g.id, g]));
        const groups = requested
            .map((id) => byId.get(id))
            .filter((g): g is MicroAgentGroup => !!g);
        return groups.length
            ? { groups, requested }
            : { groups: MICRO_AGENTS, requested };
    } catch {
        return { groups: MICRO_AGENTS, requested: [] };
    }
}
