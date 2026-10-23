/**
 * Severity prompt versions under test. Each one builds the user prompt for one
 * PR's items and is read with production's parser: {"classifications":
 * [{"index", "severity", "reason"}]}. `prod` is production's prompt itself.
 *
 * Item fields: file, lines, text, label, excerpt (head file, +-10 lines; "+"
 * = line the PR added or changed, ">" = line the comment cites).
 */
const path = require('path');
const { buildCriteriaSeverityPrompt: buildSeverityPrompt } = require(path.join(__dirname, '../../libs/code-review/infrastructure/agents/engine/severity-prompt.ts'));

const OUTPUT = `Respond with ONLY a JSON object:
\`\`\`json
{"classifications": [{"index": 0, "severity": "high", "reason": "brief reason"}]}
\`\`\``;

const block = (x, i, o) => [
    `[${i}] File: ${x.file}${x.lines ? `, lines ${x.lines}` : ''}`,
    o.label ? `Label: ${x.label}` : null,
    `Issue: ${x.text.trim()}`,
    o.code ? `Code:\n${x.excerpt || '(not available)'}` : null,
].filter(Boolean).join('\n');

// The rubric the gold was labelled with (evals/dedup/gold-v2/severidade/rubrica.md).
const RULE = `Rate the problem as the comment states it. Assume what it claims is true and rate how bad that would be; do not try to decide whether the claim is correct. Use the code only to judge how often the cited code runs and who is affected (a request handler on every call, an admin-only path, a migration, a test file, a rarely hit branch). Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.`;

const LEVELS = `- critical: an exploitable security hole (auth or permission bypass, injection, secrets or other tenants' data exposed), loss or corruption of persisted data, or an outage or crash of a core flow on ordinary input.
- high: a main feature crashes, returns a wrong result or stops working for realistic input; a caller or public API contract breaks; a security weakness that needs specific conditions; persisted state left inconsistent in a limited case.
- medium: wrong behaviour only for edge-case or uncommon input; a meaningful performance regression; missing or wrong error handling that surfaces as a confusing failure; wrong logs, metrics or messages that mislead operators or users; a test that does not verify the behaviour the change introduces.
- low: no change to what the program does for users: naming, style, readability, comments or docs, dead code, defensive checks for states that cannot happen, minor performance, test tidying.`;

const MARKS = `In the code, a "+" in the first column marks a line the pull request added or changed, and ">" in the second column marks a line the comment cites.`;

const rubric = (o) => (items) => [
    'Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.',
    RULE,
    LEVELS,
    o.code ? MARKS : null,
    'Comments:',
    items.map((x, i) => block(x, i, o)).join('\n\n'),
    OUTPUT,
].filter(Boolean).join('\n\n');

// Neighbouring levels by how often the trigger happens (gold-v2 s16).
const CALIBRATE = `How to pick between neighbouring levels:
- Find the trigger the comment states and ask how often it happens in production.
  - Ordinary: normal input, the normal use of the feature or mode the change adds (its flag turned on, its new setting enabled), and things servers do all the time — concurrent requests, retries, restarts, routine rebalances, background jobs. Rate these at full weight.
  - Specific: a race that needs unlucky timing on one record, duplicate or crafted input, an unusual configuration or provider, a failed startup or other error path, a caller that "might" pass a bad value. Rate these one level below what the same failure would get on ordinary input. Only treat a trigger as specific when the comment itself, or the code, shows it is rare; a missing optional value, an empty list, a user without some optional record, or a second request arriving are ordinary.
- critical: a permission or authentication bypass reachable with an ordinary request, stored script injection, other users' data exposed, persisted data lost or corrupted, or a core flow down — on ordinary triggers. The same with a specific trigger, a timing side channel, or exposure only to some viewers is high.
- high: a main feature, or the feature the change adds, crashes, returns wrong results or does not work on an ordinary trigger; a contract change that breaks existing callers.
- medium: the same kinds of failure with a specific trigger; performance or resource problems; confusing error handling; misleading logs, metrics or user messages; a test that no longer verifies the change.
- low: nothing a user or caller sees changes — developer scripts and tooling, test tidying, log fields or context, code comments and docs, dead code, defensive checks for states no current code produces, a redundant lookup.
- Latent problems ("if a caller ever...", "verify that...") that no current code path triggers are low or medium.`;

// Invented examples, one per boundary between levels (gold-v2).
const EXAMPLES = `Examples (invented, for calibration only):
- "Login accepts a recovery code without checking the password when a second-factor field is also sent." -> critical (authentication bypass with an ordinary request).
- "Order notes are rendered with the raw-HTML helper, so a customer can store a script that runs for every admin who opens the order." -> critical (stored script injection).
- "The coupon blocklist is lowercased but the submitted code is not, so 'SAVE50' passes while 'save50' is blocked." -> high (a security or business restriction defeated with trivial input, not a full bypass).
- "The invoice total ignores the discount line when the cart has more than one currency." -> medium (wrong result, but only for an uncommon input).
- "The new export endpoint returns an empty file for every request because the query builder is never awaited." -> high (the feature the change adds does not work on ordinary use).
- "Old calendar events are deleted inside forEach(async ...), so the deletes are not awaited and their errors are swallowed." -> medium (the work still runs; the problem is unawaited work and lost errors).
- "Two concurrent sign-ups can both pass the seat-limit count before either inserts, exceeding the limit by one." -> medium (a race that needs unlucky timing).
- "The cache lock is held across the network fetch, so concurrent cold-cache requests wait and refetch." -> low (redundant work on a cold cache, nothing users see breaks).
- "The predicate returns nil instead of false; its only caller uses it in an if." -> low (no caller observes the difference).
- "The local setup script uses BSD sed syntax and fails on Linux." -> low (developer tooling only).`;

const calibrated = (o) => (items) => [
    'Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.',
    RULE,
    o.levels || CALIBRATE,
    o.examples === false ? null : o.examples || EXAMPLES,
    o.code ? MARKS : null,
    'Comments:',
    items.map((x, i) => block(x, i, o)).join('\n\n'),
    OUTPUT,
].filter(Boolean).join('\n\n');

// Kind first, then the level the gold gives that kind (gold v3 category x severity).
const KINDS = `First decide what kind of problem the comment reports, then pick the level that kind gets:
- Documentation, comments, naming, style, a hard-coded string that should be translated, dead code, redundant work, a return value or type no current caller observes: low.
- Tests: a test that no longer verifies what the change does, or a missing test for the behaviour the change adds: medium. Test tidying, a misnamed test, cleanup in test code: low.
- Performance and resources: a slowdown, leak, N+1 query or unbounded work on a common path: medium. A small or one-off overhead, a cold-cache or per-process cost: low.
- Concurrency: a race that needs unlucky timing: medium. A race that ordinary concurrent use triggers and that loses or corrupts data: high.
- Functional bug: a crash, wrong result or broken feature on ordinary use of a main feature or of the feature the change adds: high. The same only on uncommon input, an error path or a specific configuration: medium.
- Contract: a change that breaks existing callers, a public API, a serialized format or persisted data shape: high.
- Security: an authentication or permission bypass, injection, secrets or other users' data exposed with an ordinary request, or persisted data lost or corrupted: critical. A restriction defeated by a trivial variation of the input (letter case, an alias, an unanchored pattern), or exposure that needs specific conditions: high. A timing side channel or a hardening gap with no shown exploit: medium.
A wrong result on an ordinary trigger stays high even when the effect is temporary or recoverable. When the comment says the problem is only possible, latent or unverified ("might", "if a caller ever", "verify that"), go one level down.`;

// The kinds the gold keeps low or medium whatever the wording (test 3's gain).
const SOFT_KINDS = `Some kinds of problem stay low or medium whatever the wording:
- Documentation, comments, naming, style, a hard-coded string that should be translated, dead code, redundant work, a return value or type no current caller observes: low.
- Tests: a test that no longer verifies what the change does, or a missing test for the behaviour the change adds: medium. Test tidying, a misnamed test, cleanup in test code: low.
- Performance and resources: a slowdown, leak, N+1 query or unbounded work on a common path: medium. A small or one-off overhead, a cold-cache or per-process cost: low.
Every other problem (crashes, wrong results, broken contracts, races, security) is rated by its trigger as above.`;

// Test 7: examples aligned with the gold and the reason (trigger) before the level.
const EXAMPLES_V2 = EXAMPLES
    .replace(`-> high (a security or business restriction defeated with trivial input, not a full bypass).`, `-> medium (a blocklist or allowlist defeated by a variation of the input: a weakness, not a bypass of authentication or permissions).`)
    + `
- "The settings page loads the user's billing profile without a null check, so every user who never added billing gets a 500." -> high (an ordinary user without an optional record cannot use the page).
- "When the destination has no account id, the new lookup falls back to a value that is never set, so those events are written to the default calendar instead." -> high (the change's main path gives a wrong result for an ordinary shape of data).
- "A comment says the cache holds 10 items but the constant is 20." -> low (documentation only).`;
const OUTPUT_REASON = `Respond with ONLY a JSON object. For each comment, first write the reason (what fails, its trigger and whether that trigger is ordinary or specific), then the severity:
\`\`\`json
{"classifications": [{"index": 0, "reason": "wrong total for every order with a coupon; ordinary trigger", "severity": "high"}]}
\`\`\``;
const reasoned = (o) => (items) => calibrated(o)(items).replace(OUTPUT, OUTPUT_REASON);

// Test 8: the medium/high tie goes up; a failure on the path the change adds is ordinary.
const TIE_UP = `Between medium and high: a failure on the code path the change adds or rewrites is on an ordinary trigger unless the comment shows otherwise. When still unsure between medium and high, pick high.`;

// Test 10: what the models keep raising from low.
const LOW_MORE = `Also low: a race or missing re-check whose only effect is duplicate or redundant work (two requests both fill the same cache, a value computed twice); a computed value, field or return shape that no current caller reads or shows; a retry or counter that is off only for inputs that already fail validation.`;

// Refinement 2: no discount for hedged comments; the gold rates the stated failure.
const CALIBRATE_FULL = CALIBRATE.replace(`
- Latent problems ("if a caller ever...", "verify that...") that no current code path triggers are low or medium.`, `
- Rate the failure the comment describes even when it hedges ("might", "not confirmed", "verify that"); only a problem that no current code path can reach is low or medium.`);

// Refinement 5: real gold-v3 problems outside the dataset as calibration examples.
const ANCHORS = require('./dataset/anchors.json').anchors;
const REAL_EXAMPLES = `Examples from past reviews, with the severity they were given:
${ANCHORS.map((a) => `- "${a.text}" -> ${a.severity}`).join('\n')}`;

// Test 15: the level definitions agreed from gold v3, frozen as they ran (definitions-r12.md), with examples that follow them.
const defsOf = (f) => require('fs').readFileSync(path.join(__dirname, f), 'utf8').replace(' Internally refuted findings need validity review.', '').trim();
const DEFS = defsOf('definitions-r12.md');
const DEFS_RULE = `Rate the problem as the comment states it. Assume what it claims is true and rate how bad that would be; do not try to decide whether the claim is correct. Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.`;
const DEFS_EXAMPLES = `Examples (invented, for calibration only):
- "The helper is still named loadXml although it now reads JSON." -> low
- "The new sorting branch has no test." -> medium (the change adds that behavior)
- "The retry test only checks the final result, so it passes even when no retry happens." -> medium
- "After saving a preference, the badge keeps its old value until reload." -> medium
- "A negative page size returns 500 instead of a validation error." -> medium
- "Two concurrent sign-ups can both pass the seat count, so the team ends up over its seat limit." -> high (admission cap bypassed; concurrency does not lower it)
- "Cancelling a booking leaves the event in the host's external calendar." -> high (essential calendar update fails)
- "Users without a billing profile get a 500 on the settings page." -> high
- "A viewer can call the endpoint that grants administrator access." -> critical
- "An uploaded filename is passed to a shell command without escaping." -> critical`;

// Test 16: the final definitions (definitions.md: logs low, development-only CI medium, latent
// at most medium, asserted exploits rated by the weakness), labels from the text, 205 items.
const FINAL_RULE = `Rate the problem as the comment states it. Take its facts about the code as true and rate how bad the stated consequence would be; do not try to decide whether the claim is correct. An attack the comment only asserts, without showing how it is carried out, counts as the weakness. Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.`;
const FINAL_EXAMPLES = `Examples (invented, for calibration only):
- "The helper is still named loadXml although it now reads JSON." -> low
- "The delete handler logs without the request-scoped fields, so its lines lack the user id." -> low (log content)
- "The new sorting branch has no test." -> medium (the change adds that behavior)
- "The unused import fails the lint step in CI." -> medium (blocks development only)
- "The secret is compared with !==, which leaks timing; an attacker could recover it." -> medium (asserted exploit, rated by the weakness)
- "On shutdown the last offsets are not committed, so those messages are processed again." -> medium (re-processed, not lost)
- "Two concurrent sign-ups can both pass the seat count, so the team ends up over its seat limit." -> high (admission cap bypassed; concurrency does not lower it)
- "Users without a billing profile get a 500 on the settings page." -> high
- "A viewer can call the endpoint that grants administrator access." -> critical
- "A failed send still marks every job of the batch as done, so they are never retried." -> critical (work marked done without being processed)`;

// Sonnet tests: on r13 it rated 19 of 61 high items medium, mostly a failure it took as
// limited because it hits only some users, one view or one configuration.
const r13With = ({ before = '', after = '', output = OUTPUT }) => (items) => [
    'Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.',
    FINAL_RULE,
    defsOf('definitions.md'),
    before,
    FINAL_EXAMPLES,
    after,
    'Comments:',
    items.map((x, i) => block(x, i, {})).join('\n\n'),
    output,
].filter(Boolean).join('\n\n');

// 17a: check the levels from the top down, with high spelled out as questions.
const TOP_DOWN = `Pick the level from the top down, stopping at the first one the stated consequence meets:
1. Critical: does it meet one of the critical cases above?
2. High: when it happens, does a supported path stop working for valid input (a page, action, menu item, endpoint, job or feature that errors, crashes, hangs, never appears or cannot be turned on); does an essential durable effect fail or diverge (primary records, calendar events, storage the system reads back); or does an admission or security control stop being enforced (a limit, blocklist, compliance check or permission)? Then high, even when it happens only for some users or records, in one view, under one setting or flag, or under concurrency.
3. Medium: a bounded defect from the medium list.
4. Low: otherwise.`;

// 17b: say what does not lower a failure, with examples of high that sound limited.
const NOT_LOWER = `How often the trigger occurs never lowers the level: a failure that happens only for users or records missing some row, only when a setting, flag or environment variable is used, only in one view, or only when a dependency throws is rated by what fails when it happens.`;
const NOT_LOWER_EXAMPLES = `More examples of high (invented):
- "Projects created before the migration have no owner row, so opening their settings returns a 500." -> high (a supported path fails for those projects)
- "The flag check always returns false, so the export feature cannot be turned on." -> high (a supported feature is unusable)
- "The rate limit is read before environment overrides are applied, so setting it through the environment leaves it disabled." -> high (an admission control is not enforced)
- "The archive action is gated on a field the list view never loads, so archiving is impossible from the list." -> high (a UI path is unusable)
- "The order is saved, but the warehouse sync after it is not handled; if it throws, the order exists without its shipment." -> high (an essential durable effect diverges)`;

// 17c: name the failing path or effect before the level.
const OUTPUT_PATH = `Respond with ONLY a JSON object. For each comment, first write the reason: what stops working or goes wrong when the problem happens (the path, record, control or output), and which definition above that matches; then the severity:
\`\`\`json
{"classifications": [{"index": 0, "reason": "saving a draft fails for users without a profile: a supported path unusable for valid input", "severity": "high"}]}
\`\`\``;

module.exports = {
    r17a: { describe: 'Teste 16 com a escolha de cima para baixo e o high em perguntas (Sonnet).', build: r13With({ before: TOP_DOWN }) },
    r17b: { describe: 'Teste 16 com a regra de que gatilho restrito não rebaixa e 5 exemplos de high (Sonnet).', build: r13With({ before: NOT_LOWER, after: NOT_LOWER_EXAMPLES }) },
    r17c: { describe: 'Teste 16 com o motivo antes do nível: o que deixa de funcionar e qual definição casa (Sonnet).', build: r13With({ output: OUTPUT_PATH }) },
    r13: { describe: 'Definição final (definitions.md), regra de exploit afirmado, exemplos alinhados; 205 itens rotulados pelo texto.', build: (items) => [
        'Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.',
        FINAL_RULE,
        defsOf('definitions.md'),
        FINAL_EXAMPLES,
        'Comments:',
        items.map((x, i) => block(x, i, {})).join('\n\n'),
        OUTPUT,
    ].join('\n\n') },
    r12: { describe: 'Definições acordadas no gold v3 (definitions.md), com exemplos alinhados a elas.', build: (items) => [
        'Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment index.',
        DEFS_RULE,
        DEFS,
        DEFS_EXAMPLES,
        'Comments:',
        items.map((x, i) => block(x, i, {})).join('\n\n'),
        OUTPUT,
    ].join('\n\n') },
    prod: { describe: 'Prompt de produção até o teste 17 (o de critérios, hoje só para quem customizou as flags).', build: (items) => buildSeverityPrompt(items.map((x) => ({ relevantFile: x.file, suggestionContent: x.text }))) },
    r11: { describe: 'Refino 2 com 12 exemplos reais do gold de fora do dataset.', build: calibrated({ code: false, examples: `${EXAMPLES_V2}\n\n${REAL_EXAMPLES}`, levels: `${CALIBRATE_FULL}\n\n${SOFT_KINDS}\n\n${TIE_UP}` }) },
    r10: { describe: 'Teste 8 sem desconto para sugestão que hesita.', build: calibrated({ code: false, examples: EXAMPLES_V2, levels: `${CALIBRATE_FULL}\n\n${SOFT_KINDS}\n\n${TIE_UP}` }) },
    r9: { describe: 'Teste 8 com mais casos de low.', build: calibrated({ code: false, examples: EXAMPLES_V2, levels: `${CALIBRATE}\n\n${SOFT_KINDS}\n${LOW_MORE}\n\n${TIE_UP}` }) },
    r8: { describe: 'Exemplos do teste 7, sem motivo antes, desempate para high.', build: calibrated({ code: false, examples: EXAMPLES_V2, levels: `${CALIBRATE}\n\n${SOFT_KINDS}\n\n${TIE_UP}` }) },
    r7: { describe: 'Teste 5 com exemplos alinhados ao gold e o motivo antes da severidade.', build: reasoned({ code: false, examples: EXAMPLES_V2, levels: `${CALIBRATE}\n\n${SOFT_KINDS}` }) },
    r6: { describe: 'Teste 4 com o label do achado (bug, security, performance).', build: calibrated({ code: true, label: true, levels: `${CALIBRATE}\n\n${SOFT_KINDS}` }) },
    r5: { describe: 'Teste 4 sem o trecho do código.', build: calibrated({ code: false, levels: `${CALIBRATE}\n\n${SOFT_KINDS}` }) },
    r4: { describe: 'Calibração do teste 2 mais as regras por tipo só para doc/estilo, testes e performance.', build: calibrated({ code: true, levels: `${CALIBRATE}\n\n${SOFT_KINDS}` }) },
    r3: { describe: 'Tipo do problema primeiro, depois o nível do tipo; com exemplos e o trecho do código.', build: calibrated({ code: true, levels: KINDS }) },
    r2: { describe: 'Calibração entre níveis vizinhos e exemplos inventados (s16 do gold v2), com o trecho do código.', build: calibrated({ code: true }) },
    r1: { describe: 'Rubrica que rotulou o gold, com o trecho do código.', build: rubric({ code: true }) },
};
