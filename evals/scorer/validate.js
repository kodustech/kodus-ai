/**
 * Validação do schema de submission.
 *
 * Sem dependência externa de propósito: isto roda no CI do PR de submissão de
 * terceiro, e a mensagem de erro é o que a pessoa vai ler para consertar. Erro
 * claro > validador genérico.
 *
 * Contrato completo: evals/scorer/README.md
 */

const EXECUTION_MODES = new Set(['replay', 'live']);
const ACCESS_PATHS = new Set(['api', 'subscription', 'local', 'unknown']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info']);
const REASONING_CONFIGS = new Set(['vendor-default', 'explicit', 'disabled']);

function isObj(v) {
    return v && typeof v === 'object' && !Array.isArray(v);
}

function validateSubmission(s) {
    const errs = [];
    const req = (cond, msg) => {
        if (!cond) errs.push(msg);
    };

    req(isObj(s), 'raiz deve ser um objeto JSON');
    if (!isObj(s)) return errs;

    req(typeof s.benchmarkVersion === 'string' && s.benchmarkVersion,
        'benchmarkVersion: string obrigatória (ex: "light-30-v1")');

    // ── run ──
    const run = s.run;
    req(isObj(run), 'run: objeto obrigatório');
    if (isObj(run)) {
        req(isObj(run.harness) && typeof run.harness.name === 'string' && run.harness.name,
            'run.harness.name: string obrigatória (ex: "kodus", "claude-code", "greptile")');

        // model é opcional: harness fechado (Greptile) não expõe escolha de modelo.
        if (run.model !== null && run.model !== undefined) {
            req(isObj(run.model), 'run.model: objeto ou null (null = harness não permite escolher modelo)');
            if (isObj(run.model)) {
                req(typeof run.model.id === 'string' && run.model.id,
                    'run.model.id: string obrigatória quando run.model não é null');
                if (run.model.accessPath !== undefined) {
                    req(ACCESS_PATHS.has(run.model.accessPath),
                        `run.model.accessPath deve ser um de: ${[...ACCESS_PATHS].join(', ')}`);
                }
            }
        }

        req(EXECUTION_MODES.has(run.executionMode),
            `run.executionMode deve ser um de: ${[...EXECUTION_MODES].join(', ')}`);

        // Opcional, mas quando presente precisa dizer sob qual regime rodou:
        // effort é confundidor entre modelos (defaults de vendor divergem muito).
        if (run.reasoning !== undefined && run.reasoning !== null) {
            req(isObj(run.reasoning), 'run.reasoning: objeto quando presente');
            if (isObj(run.reasoning)) {
                req(REASONING_CONFIGS.has(run.reasoning.config),
                    `run.reasoning.config deve ser um de: ${[...REASONING_CONFIGS].join(', ')}`);
                if (run.reasoning.config === 'explicit') {
                    req(
                        typeof run.reasoning.effortRequested === 'string' && run.reasoning.effortRequested,
                        'run.reasoning.effortRequested: obrigatório quando config="explicit" (senão "explicit" não diz nada)',
                    );
                }
            }
        }
        req(typeof run.runAt === 'string' && !Number.isNaN(Date.parse(run.runAt)),
            'run.runAt: timestamp ISO-8601 obrigatório');
    }

    // ── results ──
    req(Array.isArray(s.results), 'results: array obrigatório');
    if (Array.isArray(s.results)) {
        req(s.results.length > 0, 'results: não pode ser vazio');
        const seen = new Set();
        s.results.forEach((r, i) => {
            const at = `results[${i}]`;
            if (!isObj(r)) {
                errs.push(`${at}: deve ser objeto`);
                return;
            }
            req(typeof r.caseId === 'string' && r.caseId, `${at}.caseId: string obrigatória`);
            if (r.caseId) {
                req(!seen.has(r.caseId), `${at}.caseId duplicado: ${r.caseId}`);
                seen.add(r.caseId);
            }
            // findings vazio é VÁLIDO e significativo: "não achei nada neste PR".
            req(Array.isArray(r.findings), `${at}.findings: array obrigatório (use [] se não houve finding)`);
            if (Array.isArray(r.findings)) {
                r.findings.forEach((f, j) => {
                    const fat = `${at}.findings[${j}]`;
                    if (!isObj(f)) {
                        errs.push(`${fat}: deve ser objeto`);
                        return;
                    }
                    req(typeof f.description === 'string' && f.description.trim(),
                        `${fat}.description: string não-vazia obrigatória (é o texto que o judge compara)`);
                    if (f.path !== undefined) {
                        req(typeof f.path === 'string', `${fat}.path: string quando presente`);
                    }
                    for (const k of ['startLine', 'endLine']) {
                        if (f[k] !== undefined && f[k] !== null) {
                            req(Number.isInteger(f[k]) && f[k] > 0, `${fat}.${k}: inteiro positivo quando presente`);
                        }
                    }
                    // null = não informado (ou normalizado por vir inválido do
                    // modelo — ver severityRaw). Só valida quando há valor.
                    if (f.severity !== undefined && f.severity !== null) {
                        req(SEVERITIES.has(f.severity),
                            `${fat}.severity deve ser um de: ${[...SEVERITIES].join(', ')}, ou null`);
                    }
                });
            }
            if (r.usage !== undefined && r.usage !== null) {
                req(isObj(r.usage), `${at}.usage: objeto quando presente`);
            }
        });
    }

    return errs;
}

module.exports = { validateSubmission, EXECUTION_MODES, ACCESS_PATHS, SEVERITIES, REASONING_CONFIGS };
