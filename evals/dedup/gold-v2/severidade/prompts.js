/**
 * Versoes do prompt de severidade. Cada versao: { modo: 'um' | 'pr', prompt(itens) }.
 * 'um' = uma chamada por sugestao; 'pr' = uma chamada com todas as sugestoes do PR.
 * O codigo existente e o recorte do head (+-10 linhas, '+' = alterada pelo PR, '>' = citada).
 */
const NIVEIS = `- critical: an exploitable security hole (auth or permission bypass, injection, secrets or other tenants' data exposed), loss or corruption of persisted data, or an outage or crash of a core flow on ordinary input.
- high: a main feature crashes, returns a wrong result or stops working for realistic input; a caller or public API contract breaks; a security weakness that needs specific conditions; persisted state left inconsistent in a limited case.
- medium: wrong behaviour only for edge-case or uncommon input; a meaningful performance regression; missing or wrong error handling that surfaces as a confusing failure; wrong logs, metrics or messages that mislead operators or users; a test that does not verify the behaviour the change introduces.
- low: no change to what the program does for users: naming, style, readability, comments or docs, dead code, defensive checks for states that cannot happen, minor performance, test tidying.`;

const REGRA = `Rate the problem as the comment states it. Assume what it claims is true and rate how bad that would be; do not try to decide whether the claim is correct. Use the code only to judge how often the cited code runs and who is affected (a request handler on every call, an admin-only path, a migration, a test file, a rarely hit branch). Do not raise the severity because the comment uses alarming words, and do not lower it because the fix is small.`;

const MARCAS = `In the code, a "+" in the first column marks a line the pull request added or changed, and ">" in the second column marks a line the comment cites.`;

const bloco = (x) => `<comment id="${x.id}">
File: ${x.file}
Lines: ${x.lines[0] ?? '?'}-${x.lines[1] ?? '?'}
${String(x.texto).trim()}

Existing code:
${x.recorte || '(not available)'}
</comment>`;

const v = {};

// A rubrica do rotulo, uma sugestao por chamada, so a severidade.
v.s1 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${NIVEIS}

${MARCAS}

${bloco(x)}` };

// A mesma rubrica, todas as sugestoes do PR numa chamada.
v.s2 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${NIVEIS}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };

// s1 com uma frase de justificativa antes da severidade.
v.s3 = { modo: 'um', campos: ['reason', 'severity'], prompt: ([x]) => `${v.s1.prompt([x])}

First write one sentence naming the stated consequence and how often the code runs, then the severity.` };

module.exports = v;

// Calibracao: os criterios que separam niveis vizinhos, onde as versoes s1/s2 superestimam.
const CALIBRA = `How to pick between neighbouring levels:
- Find the trigger the comment states. If the failure needs a specific condition — a race between concurrent requests, duplicate or crafted input, a particular configuration, provider or feature-flag state, a startup or error path, or a caller that "might" pass a bad value — rate it one level below what the same failure would get if it happened on ordinary input.
- high needs the stated failure to hit realistic, ordinary use of a main feature. A wrong result in one uncommon path, query shape or setting is medium.
- critical needs a security hole that works without unusual conditions, or loss of persisted data or an outage on ordinary input of a core flow. A timing side channel, a bypass that needs specific state, or exposure under specific viewer conditions is high.
- When nothing a user or caller sees changes, it is low: developer scripts and tooling, tests (except a test that no longer verifies the change, which is medium), log fields or log context, code comments and docs, leaked resources only on a failed startup, a duplicate or redundant lookup.
- Latent problems ("if a caller ever...", "would break if...", "verify that...") that no current code path triggers are low or medium, never high.
- When still unsure between two levels, pick the lower one.`;

v.s4 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${NIVEIS}

${CALIBRA}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };

v.s5 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${NIVEIS}

${CALIBRA}

${MARCAS}

${bloco(x)}` };

// Calibracao 2: s4/s5 rebaixaram demais; separa condicao especifica de uso normal.
const CALIBRA2 = `How to pick between neighbouring levels:
- Find the trigger the comment states and ask how often it happens in production.
  - Ordinary: normal input, the normal use of the feature or mode the change adds (its flag turned on, its new setting enabled), and things servers do all the time — concurrent requests, retries, restarts, routine rebalances, background jobs. Rate these at full weight.
  - Specific: a race that needs unlucky timing on one record, duplicate or crafted input, an unusual configuration or provider, a failed startup or other error path, a caller that "might" pass a bad value. Rate these one level below what the same failure would get on ordinary input.
- critical: a permission or authentication bypass reachable with an ordinary request, stored script injection, other users' data exposed, persisted data lost or corrupted, or a core flow down — on ordinary triggers. The same with a specific trigger, a timing side channel, or exposure only to some viewers is high.
- high: a main feature, or the feature the change adds, crashes, returns wrong results or does not work on an ordinary trigger; a contract change that breaks existing callers.
- medium: the same kinds of failure with a specific trigger; performance or resource problems; confusing error handling; misleading logs, metrics or user messages; a test that no longer verifies the change.
- low: nothing a user or caller sees changes — developer scripts and tooling, test tidying, log fields or context, code comments and docs, dead code, defensive checks for states no current code produces, a redundant lookup.
- Latent problems ("if a caller ever...", "verify that...") that no current code path triggers are low or medium.`;

v.s6 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${CALIBRA2}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };

v.s7 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${CALIBRA2}

${MARCAS}

${bloco(x)}` };

// Fatores: o modelo classifica impacto, gatilho e alcance; o nivel sai de uma regra fixa.
const IMPACTOS = {
    security_bypass: 'permission or authentication bypass, script/SQL injection, secrets or other users\' data exposed',
    data_loss: 'persisted data lost, deleted or corrupted',
    crash_or_outage: 'a flow crashes, errors out or stops running',
    wrong_result: 'a feature returns wrong results, does the wrong thing or silently does nothing',
    contract_break: 'existing callers or API consumers break because a signature, return value or behaviour they rely on changed',
    security_weakness: 'a weakness that helps an attacker but is not a direct bypass (timing side channel, missing hardening, weak randomness, sensitive data in logs)',
    inconsistent_state: 'stored state left inconsistent or stale (leftover rows, out-of-sync copies) without losing data',
    performance: 'slower, more queries, more memory, unbounded growth, resource or goroutine leaks',
    error_handling: 'an error surfaces as a confusing failure or is swallowed',
    misleading_output: 'wrong or misleading logs, metrics, messages or UI text',
    test_not_verifying: 'a test that does not verify the behaviour the change introduces',
    no_behaviour_change: 'nothing a user or caller sees changes: naming, style, comments, docs, dead code, test tidying, developer scripts',
};
const BASE = { security_bypass: 3, data_loss: 3, crash_or_outage: 3, wrong_result: 2, contract_break: 2, security_weakness: 2, inconsistent_state: 2,
    performance: 1, error_handling: 1, misleading_output: 1, test_not_verifying: 1, no_behaviour_change: 0 };
const NOMES = ['low', 'medium', 'high', 'critical'];
const derivaFatores = (d) => {
    let n = BASE[d.impact] ?? 1;
    if (d.impact === 'crash_or_outage' && d.reach !== 'core_flow') n = 2;
    if (d.reach === 'developer_or_test_only' && d.impact !== 'test_not_verifying') n = 0;
    if (d.trigger === 'specific') n -= 1;
    if (d.trigger === 'latent') n = Math.min(n - 1, 1);
    return NOMES[Math.max(0, Math.min(3, n))];
};
const FATORES = `For each comment, classify three things about the problem as the comment states it (assume the claim is true; use the code to judge how often it runs and who it affects).

impact — the worst consequence the comment states:
${Object.entries(IMPACTOS).map(([k, d]) => `- ${k}: ${d}`).join('\n')}

trigger — what has to happen for that consequence:
- ordinary: normal input, the normal use of the feature or mode the change adds (its flag or setting turned on), or things servers do all the time (concurrent requests, retries, restarts, routine rebalances, background jobs).
- specific: a race that needs unlucky timing on one record, duplicate or crafted input, an unusual configuration or provider, a failed startup or other error path.
- latent: no current code path triggers it; only a future or hypothetical caller would ("if a caller ever...", "verify that...").

reach — where the cited code runs:
- core_flow: a main user-facing flow of the product (sign-in, permissions, the central request/booking/ingest path, data storage).
- secondary_feature: a narrower feature, admin screen, integration, job or setting.
- developer_or_test_only: tests, developer scripts, build tooling.`;

v.s8 = { modo: 'pr', campos: ['impact', 'trigger', 'reach'], enums: { impact: Object.keys(IMPACTOS), trigger: ['ordinary', 'specific', 'latent'], reach: ['core_flow', 'secondary_feature', 'developer_or_test_only'] },
    deriva: derivaFatores, prompt: (xs) => `${FATORES}

${MARCAS}

Return one item per comment id.

${xs.map(bloco).join('\n\n')}` };
v.derivaFatores = derivaFatores;

// s5 com raciocinio curto antes da nota.
v.s9 = { modo: 'um', campos: ['reason', 'severity'], prompt: ([x]) => `${v.s5.prompt([x])}

First write one or two sentences: the consequence the comment states, what triggers it and how often that happens, and who notices. Then give the severity.` };

// Exemplos sinteticos (dominios inventados, nada do benchmark), um por fronteira entre niveis.
const EXEMPLOS = `Examples (invented, for calibration only):
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

v.s10 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${NIVEIS}

${CALIBRA}

${EXEMPLOS}

${MARCAS}

${bloco(x)}` };

// Calibracao equilibrada (CALIBRA2) + exemplos sinteticos.
v.s11 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${CALIBRA2}

${EXEMPLOS}

${MARCAS}

${bloco(x)}` };
v.s12 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${CALIBRA2}

${EXEMPLOS}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };

// s12/s11 + equilibrio: dois exemplos high e a regra de nao rebaixar efeito temporario.
const EXEMPLOS2 = `${EXEMPLOS}
- "A permission denial is cached for 30 seconds, so a user who just created a project is told they cannot open it." -> high (a wrong result on an ordinary flow, even though it clears by itself).
- "When the optional delivery note is missing, the nightly import raises and stops, skipping every remaining order." -> high (a common input shape breaks a job for everyone after it).
A wrong result on an ordinary trigger stays high even when the effect is temporary, recoverable or only shown in the UI.`;
v.s13 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${CALIBRA2}

${EXEMPLOS2}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };
v.s14 = { modo: 'um', campos: ['severity'], prompt: ([x]) => `Assign this code review comment one severity: low, medium, high or critical.

${REGRA}

${CALIBRA2}

${EXEMPLOS2}

${MARCAS}

${bloco(x)}` };

// s12 + tres lacunas recorrentes: crash no recurso novo, ferramenta de build x script local, dado sensivel em log.
const LACUNAS = `More rules:
- A crash, 500 or exception in the feature the change adds, for a state ordinary users are in (a missing optional row, a missing optional field, a common data shape), is high.
- Build-time verifiers, linters and CI checks that crash or misreport are medium; local developer scripts are low.
- Attacker-controlled or sensitive data written to logs from a public endpoint is high.
- A test that can hang or leak, or a test helper or fixture problem, is low unless it makes the test stop verifying the change (then medium).`;
v.s15 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${CALIBRA2}

${LACUNAS}

${EXEMPLOS}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };

// s12 com o desconto por gatilho mais estreito: o modelo rebaixava demais.
const CALIBRA3 = CALIBRA2
    .replace('Rate these one level below what the same failure would get on ordinary input.',
        'Rate these one level below what the same failure would get on ordinary input. Only treat a trigger as specific when the comment itself, or the code, shows it is rare; a missing optional value, an empty list, a user without some optional record, or a second request arriving are ordinary.');
v.s16 = { modo: 'pr', campos: ['severity'], prompt: (xs) => `Assign each code review comment below one severity: low, medium, high or critical. Return one item per comment id.

${REGRA}

${CALIBRA3}

${EXEMPLOS}

${MARCAS}

${xs.map(bloco).join('\n\n')}` };
