#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env'), quiet: true });
require('dotenv').config({ path: require('path').join(__dirname, '../../../../.env.local'), override: true, quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
/**
 * Verify de alucinacao depois do dedup (#1821): um comentario por vez, sem o
 * diff, com a saida enxuta da sugestao e um loop de grep/readFile/listDir no
 * commit do PR (--teto, padrao 6). Pergunta se o comentario se apoia num fato
 * falso sobre o codigo; remove so "refuted" com evidencia citada. Mesmos
 * grupos do dedup congelado de nit.js.
 *
 *   RECALL_MODEL=<id> node evals/dedup/gold-v2/verify/alucinacao.js --model=<gold model> --versao=h1 [--teto=6] [--par=3]
 */
const fs = require('fs');
const path = require('path');
const { generateText, tool, jsonSchema } = require('ai');
const INV = path.join(__dirname, '..', '..', '..', 'investigation');
const { buildModel, descreveModelo } = require(path.join(INV, 'eval-model'));
const { extraiJson, chamadaEstruturada } = require(path.join(INV, 'eval-structured'));
const { prepareRepo } = require(path.join(INV, 'prepare-repo'));
const { LocalRepoCommands } = require(path.join(INV, 'local-repo-commands'));

const arg = (n, d) => { const h = process.argv.slice(2).find((a) => a.startsWith(`--${n}=`)); return h ? h.split('=').slice(1).join('=') : d; };
// --prefixo: outro conjunto de PRs (ex.: holdout) no lugar do light de 09/10.
const PREFIXO = arg('prefixo', '09.10.26');
const GOLD = arg('model'), VERSAO = arg('versao', 'h1'), PAR = Number(arg('par', '3')), DEDUP = arg('dedup', 'v9-cobertura');
const MODELO = process.env.RECALL_MODEL;
if (!GOLD || !MODELO) { console.error('RECALL_MODEL=<id> --model=<gold model>'); process.exit(2); }
const semToolChoiceNomeado = /muse|kimi|glm/i.test(MODELO);
const OUT = path.join(__dirname, 'resultados', `aluc-${VERSAO}`, `${GOLD}.json`);
fs.mkdirSync(path.dirname(OUT), { recursive: true });

const TETO = Number(arg('teto', '6'));
// --esforco: reasoning effort no provedor openai_compatible (Muse); --prs: lista de PRs;
// --apos: pula os grupos que esse resultado ja derrubou.
const ESFORCO = arg('esforco');
// --h3=1: passo 1 le o arquivo na base e o diff do PR. --h4=1: passo 1 roda um trecho isolado num sandbox E2B.
const H3 = arg('h3') === '1', H4 = arg('h4') === '1', H2 = arg('h2') === '1';
const EXTRA = [
    H3 ? 'To check what the pull request changed, or how the code behaved before it, read the file at the base commit with readBaseFile and the pull request diff of a file with prDiff.' : '',
    H2 ? 'To check who calls a function or method (and whether those callers are tests), use getCallers; it reads the repository call graph.' : '',
    H4 ? 'To check how a language, library or command-line tool behaves (what a regex matches, what an expression evaluates to, what a command outputs), run a small self-contained snippet with runSnippet (python, node or bash) and read its output. Snippets cannot import this repository.' : '',
].filter(Boolean).join(' ');
const comExtra = (t) => (EXTRA ? t.replace(/\n\nYou have at most /, `\n\n${EXTRA}\n\nYou have at most `) : t);
// Um sandbox E2B por PR, criado no primeiro uso e encerrado no fim do PR.
async function rodaTrecho(cmd, language, code) {
    if (!cmd.sandbox) {
        const { Sandbox } = require('e2b');
        cmd.sandbox = await Sandbox.create({ apiKey: process.env.API_E2B_KEY, timeoutMs: 10 * 60 * 1000 });
    }
    const arq = { python: '/tmp/s.py', node: '/tmp/s.js', bash: '/tmp/s.sh' }[language];
    const bin = { python: 'python3', node: 'node', bash: 'bash' }[language];
    if (!arq) return 'language must be python, node or bash';
    await cmd.sandbox.files.write(arq, String(code));
    try {
        const r = await cmd.sandbox.commands.run(`${bin} ${arq}`, { timeoutMs: 20000 });
        return `exit ${r.exitCode}\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`.slice(0, 6000);
    } catch (e) {
        return `exit ${e?.exitCode ?? '?'}\nstdout:\n${e?.stdout ?? ''}\nstderr:\n${e?.stderr ?? e?.message ?? e}`.slice(0, 6000);
    }
}
// H2: grafo de chamadas = baseline do repo inteiro na base (cache do eval) sem
// as arestas dos arquivos alterados, mais o grafo do PR (arquivos alterados, no head).
function carregaGrafo(v) {
    const { repoDirFor } = require(path.join(INV, 'prepare-repo'));
    const repoDir = repoDirFor(v.repositoryFullName);
    let base = v.benchmarkBaseRef;
    if (!base) base = require('child_process').execFileSync('git', ['-C', repoDir, 'rev-parse', `${v.benchmarkHeadRef}^`]).toString().trim();
    const arq = path.join(require('os').homedir(), 'projects', 'benchmark', '.callgraph', '_baselines', `${path.basename(repoDir)}-${base.slice(0, 12)}.json`);
    const pr = typeof v.callGraphJson === 'string' ? JSON.parse(v.callGraphJson) : (v.callGraphJson || { nodes: [], edges: [] });
    let cf = v.changedFilesFull || v.changedFiles; if (typeof cf === 'string') cf = JSON.parse(cf);
    const alterados = new Set((cf || []).map((x) => x.filename));
    const b = fs.existsSync(arq) ? JSON.parse(fs.readFileSync(arq, 'utf8')) : { nodes: [], edges: [] };
    const teste = new Map([...b.nodes, ...pr.nodes].map((n) => [n.qualified_name, !!n.is_test]));
    const edges = [...b.edges.filter((e) => !alterados.has(e.file_path)), ...pr.edges].filter((e) => e.kind === 'CALLS');
    return { edges, teste, temBaseline: b.edges.length > 0 };
}
function getCallers(cmd, nome) {
    const n = String(nome || '').trim().split(/::|\.|#/).pop();
    if (!n) return 'give a function or method name';
    const hits = cmd.grafo.edges.filter((e) => { const t = e.target_qualified || ''; return t.endsWith(`::${n}`) || t.endsWith(`.${n}`); });
    if (!hits.length) return `no callers of ${n} in the call graph${cmd.grafo.temBaseline ? '' : ' (only the changed files are indexed)'}; the graph can miss dynamic calls, so confirm with grep before concluding none exist`;
    const linhas = [...new Set(hits.map((e) => `${e.file_path}:${e.line}  ${e.source_qualified} -> ${e.target_qualified}${cmd.grafo.teste.get(e.source_qualified) ? '  [test]' : ''}`))];
    return `${linhas.length} call sites of ${n}:\n${linhas.slice(0, 40).join('\n')}${linhas.length > 40 ? `\n... ${linhas.length - 40} more` : ''}`;
}
function prDiff(cmd, p) {
    try {
        const a = ['-C', cmd.repoRoot, 'diff', `${cmd.baseRef}...${cmd.headRef}`];
        if (p) a.push('--', String(p).replace(/^\/+/, ''));
        else a.push('--stat');
        const out = require('child_process').execFileSync('git', a, { maxBuffer: 32 * 1024 * 1024 }).toString();
        return (out || 'no changes in this file').slice(0, 12000);
    } catch (e) { return `diff failed: ${String(e?.message || e).slice(0, 200)}`; }
}
const SO_PRS = arg('prs') ? new Set(fs.readFileSync(arg('prs'), 'utf8').split(/\s+/).filter(Boolean)) : null;
const APOS = arg('apos') ? JSON.parse(fs.readFileSync(path.join(__dirname, 'resultados', arg('apos'), `${GOLD}.json`), 'utf8')).prs : null;
const VEREDITOS = VERSAO.startsWith('u') ? ['refuted', 'nit', 'confirmed', 'unverified'] : ['refuted', 'confirmed', 'unverified'];
const SCHEMA = {
    type: 'object',
    properties: {
        verdict: { type: 'string', enum: VEREDITOS },
        claim: { type: 'string', description: 'For refuted: the false sentence, copied word for word from the comment.' },
        evidence: { type: 'string', description: 'For refuted: file:line and the quoted code that contradicts the comment.' },
        reason: { type: 'string', description: 'One sentence.' },
    },
    required: ['verdict', 'claim', 'evidence', 'reason'],
    additionalProperties: false,
};

const comentario = (s) => `<Comment>
File: ${s.relevantFile}
Lines: ${s.relevantLinesStart ?? '?'}-${s.relevantLinesEnd ?? '?'}
Label: ${s.label ?? '?'}
${String(s.suggestionContent || '').trim()}
</Comment>`;

const PROMPTS = {
    h1: (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to check whether the comment is built on a false statement about the code.

${comentario(s)}

Review comments sometimes misread the code. They say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass. Such a comment is refuted: the problem it reports does not exist, because a fact it rests on is false.

1. List the statements of fact the comment relies on: what the code at the cited lines does, what the other code it names does, which callers, files or values exist.
2. Check them in the repository at this pull request's commit with grep, readFile and listDir. Start with the cited file and lines.
3. Answer "refuted" only when you found code that contradicts a statement the reported problem depends on. Put that code, with its file and line, in evidence.

Answer "confirmed" when the statements you checked hold, and "unverified" when you could not check them. A comment is not refuted because:
- the scenario seems unlikely, or you did not find a caller that triggers it today;
- the impact seems small, or the fix is optional;
- the comment is vague, speculative or a style remark.
Those questions belong to other reviewers. When in doubt, do not answer "refuted".

You have at most ${TETO} steps in total. Answer with submit.`,
    h3: (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to check whether the comment states something false about the code in this repository.

${comentario(s)}

Review comments sometimes misread the code. They say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass.

1. Pick the sentences of the comment that state facts about this repository's code: what the cited lines do, what the other code it names does, which callers, overrides, files, settings or values exist.
2. Check them with grep, readFile and listDir at this pull request's commit. Start with the cited file and lines, then follow the code the comment names.
3. Answer "refuted" only when you found code in this repository that shows one of those sentences is false. In claim, copy that sentence word for word from the comment. In evidence, quote the code with its file and line.

Only code in this repository counts as evidence. These do not refute a comment:
- what you know about how a language, library, framework or external tool behaves;
- documentation, comments or setting descriptions about what values usually look like;
- the scenario seeming unlikely, no caller triggering it today, or a type that "never" returns the bad value;
- small impact, an optional fix, a vague or speculative comment.

Answer "confirmed" when the sentences you checked hold, and "unverified" when you could not check them. When in doubt, do not answer "refuted".

You have at most ${TETO} steps in total. Answer with submit.`,
    // g1: o h1, mas a ausencia vale como prova quando o comentario afirma que a coisa existe.
    g1: (s) => PROMPTS.h1(s)
        .replace('3. Answer "refuted" only when', 'When the comment states that something exists in this repository today (callers that still use an old form, implementations or overrides with an old signature, a consumer, a file, a setting), that is a statement of fact too: if a search of the whole repository finds none, the statement is false. A comment about what would happen if a future caller or input did something does not state that it exists.\n\n3. Answer "refuted" only when')
        .replace('- the scenario seems unlikely, or you did not find a caller that triggers it today;', '- the scenario seems unlikely, or you did not find a caller that triggers it today, unless the comment states that such a caller exists;'),
    // r1: como o h1, mas o estado ou o consumidor que dispara a falha tambem e um fato a checar.
    r1: (s) => `An AI code reviewer wants to post the comment below on a pull request. Your only job is to check whether the problem it reports can actually happen in this repository.

${comentario(s)}

Review comments sometimes describe failures that cannot happen. They say a function is called where it is not, that a caller was not updated when it was, that a check is missing when it is there, that an expression throws when the language short-circuits it, that a value can be empty when every path that reaches the line guarantees it is not, or that "any caller still doing X" breaks when no such caller exists and the language or build would reject one. Such a comment is refuted.

1. Write down the failure the comment reports and the condition that triggers it: the input, state, caller, consumer or configuration it needs.
2. Check, with grep, readFile and listDir at this pull request's commit, whether that condition can occur: who calls the cited code, what they pass, which guards and invariants hold on every path, which implementations or consumers exist, which configurations are allowed. Start with the cited file and lines.
3. Answer "refuted" when you found code showing that a fact the failure needs is false, or that the triggering condition cannot occur in this repository (every path that reaches the code rules it out, or the consumer it needs does not exist). Put that code, with its file and line, in evidence.

Answer "confirmed" when the failure can happen, and "unverified" when you could not tell. A comment is not refuted because:
- the failure is in new or public code that a future caller, a user input or an external client can trigger, even if no current caller does;
- the impact seems small, or the fix is optional;
- the comment is vague, speculative or a style remark.
When in doubt, do not answer "refuted".

You have at most ${TETO} steps in total. Answer with submit.`,
    // r2: o r1 mais "ja existia antes do PR" (com o base) e sem o escudo de API publica sem caminho concreto.
    r2: (s) => PROMPTS.r1(s)
        .replace('Answer "refuted" when you found code showing', 'Also check, with readBaseFile, whether the reported behavior was already there before this pull request: if the same code did the same thing under the same conditions before the change, and the pull request neither introduced, moved nor changed it, the comment blames the pull request for something it did not do, and that is a false fact too.\\n\\nAnswer "refuted" when you found code showing')
        .replace('- the failure is in new or public code that a future caller, a user input or an external client can trigger, even if no current caller does;', '- the failure is in new or changed code and you can name a concrete input path that reaches it (a request field, a user action, a configuration value, a caller in this repository). Being public, exported or "callable by an external client" is not enough on its own: name the path;'),
    // r3: o r1 mais "ja existia antes do PR" (com o base), mantendo o escudo de codigo novo ou publico.
    r3: (s) => PROMPTS.r1(s)
        .replace('Answer "refuted" when you found code showing', 'Also check, with readBaseFile, whether the reported behavior was already there before this pull request: if the same code did the same thing under the same conditions before the change, and the pull request neither introduced, moved nor changed it, the comment blames the pull request for something it did not do, and that is a false fact too.\\n\\nAnswer "refuted" when you found code showing'),
    // u1: um veredito so, com nit como valor; refuted e nit seguem para o filtro.
    u1: (s) => `An AI code reviewer wants to post the comment below on a pull request. Check the comment against the code in this repository and give it one verdict.

${comentario(s)}

The four verdicts:

- "refuted": the comment rests on a false statement about the code, so the problem it reports does not exist. Review comments sometimes misread the code: they say a function is called where it is not, that a caller was not updated when it was, that a value is a per-request secret when it is a constant, that a check is missing when it is there, that a regex matches characters it does not, or that a test fails when the test setup makes it pass. Use "refuted" only when you found code in this repository that contradicts a statement the reported problem depends on, and quote that code in evidence.

- "nit": what the comment says about the code is true, but the change it asks for is optional: if the author ignores it and merges, nothing crashes, returns a wrong result, loses or corrupts data, opens a security hole, breaks a caller, or misleads a reader with a false statement. Nits include:
  - defensive code "just in case": a null check, validation, guard, try/catch or fallback, with no concrete input or path that makes the code fail;
  - speculative concerns: "could break if", "may cause issues later", "consider what happens when", with no concrete failure described;
  - style, naming, formatting, readability, comments, logging, dead code, refactoring, extracting helpers or constants;
  - requests to add tests or more test coverage;
  - best practices, consistency, configurability, future-proofing, micro-optimizations with no real cost.
  For example, "Consider checking that items is not null before iterating" is a nit; "items is null when the request has no body, because the handler passes req.body?.items straight through, and the loop on line 40 then throws" is not. "Use a named constant instead of the magic number 3" is a nit; "the retry loop uses <= 3, so it makes four attempts while the setting says three" is not.

- "confirmed": the statements of the comment hold and it describes a real problem: a concrete failure, not an optional change.

- "unverified": you could not check the comment's statements.

Decide in this order. First check the facts: if a statement the problem depends on is false, the verdict is "refuted". If the facts hold, decide whether the change is optional: "nit" or "confirmed".

How to check: list the statements of fact the comment relies on (what the code at the cited lines does, what the other code it names does, which callers, files or values exist), then check them with grep, readFile and listDir at this pull request's commit, starting with the cited file and lines.

None of these makes a comment "refuted": the scenario seeming unlikely, not finding a caller that triggers it today, small impact, or a vague or speculative wording. Those are not false statements; a speculative or optional comment is a "nit" when its facts hold. When in doubt between "refuted" and anything else, do not answer "refuted".

In evidence, quote the code behind your verdict with its file and line. You have at most ${TETO} steps in total. Answer with submit.`,
};

const norm = (t) => String(t || '').toLowerCase().replace(/[`*_"'\s]+/g, ' ').trim();

/** nit = o que este verify removeria: refuted com evidencia (h3: e com a frase copiada do comentario). */
function normaliza(d, s) {
    if (!VEREDITOS.includes(d?.verdict)) throw new Error('sem resposta');
    let ok = (d.verdict === 'refuted' && String(d.evidence || '').trim().length > 0) || d.verdict === 'nit';
    let claimNoTexto = null;
    if (ok && VERSAO === 'h3') {
        const c = norm(d.claim);
        claimNoTexto = c.length >= 15 && norm(s.suggestionContent).includes(c.slice(0, 60));
        ok = claimNoTexto;
    }
    return { nit: ok, verdict: d.verdict, claim: d.claim || '', claimNoTexto, evidence: d.evidence || '', reason: d.reason || '' };
}

function grupos(sugs, final, entrada) {
    const chegou = new Set(entrada);
    const porGrupo = {};
    const out = [];
    for (const s of sugs) {
        if (!chegou.has(s.id)) continue;
        const g = final[s.id]?.grupo;
        if (g) (porGrupo[g] = porGrupo[g] || []).push(s); else out.push([s]);
    }
    out.push(...Object.values(porGrupo));
    return out.map((m) => {
        const rep = m.reduce((a, b) => (String(b.suggestionContent).length > String(a.suggestionContent).length ? b : a));
        return { rep: rep.id, membros: m.map((x) => x.id), s: rep };
    });
}

function ferramentas(cmd) {
    return {
        ...(cmd.baseRef ? { readBaseFile: tool({
            description: 'Read a file as it was BEFORE the pull request (base commit), optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => {
                try {
                    const out = require('child_process').execFileSync('git', ['-C', cmd.repoRoot, 'show', `${cmd.baseRef}:${String(p).replace(/^\/+/, '')}`], { maxBuffer: 32 * 1024 * 1024 }).toString();
                    const ls = out.split('\n'); const a = Math.max(1, Number(startLine) || 1), b = Math.min(ls.length, Number(endLine) || ls.length);
                    return ls.slice(a - 1, b).map((l, k) => `${a + k}: ${l}`).join('\n').slice(0, 12000);
                } catch { return 'file not found at the base commit (new in this pull request, or wrong path)'; }
            },
        }) } : {}),
        ...(H3 ? { prDiff: tool({
            description: 'Show the pull request diff of one file (or, with no path, the list of changed files).',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' } }, additionalProperties: false }),
            execute: async ({ path: p }) => prDiff(cmd, p),
        }) } : {}),
        ...(H2 ? { getCallers: tool({
            description: 'List the call sites of a function or method in the repository call graph, marking callers that are tests.',
            inputSchema: jsonSchema({ type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false }),
            execute: async ({ name }) => getCallers(cmd, name),
        }) } : {}),
        ...(H4 ? { runSnippet: tool({
            description: 'Run a small self-contained snippet in an isolated sandbox and return its exit code, stdout and stderr. No access to this repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { language: { type: 'string', enum: ['python', 'node', 'bash'] }, code: { type: 'string' } }, required: ['language', 'code'], additionalProperties: false }),
            execute: async ({ language, code }) => rodaTrecho(cmd, language, code),
        }) } : {}),
        grep: tool({
            description: 'Search the repository for a regex pattern.',
            inputSchema: jsonSchema({ type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'], additionalProperties: false }),
            execute: async ({ pattern, path: p, glob }) => String(await cmd.grep(pattern, p, glob)).slice(0, 6000),
        }),
        readFile: tool({
            description: 'Read a file, optionally a line range.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, endLine: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, startLine, endLine }) => { const t = String(await cmd.read(p, startLine, endLine)); const b = Number(startLine) > 0 ? Number(startLine) : 1; return t.split('\n').map((l, k) => `${b + k}: ${l}`).join('\n').slice(0, 12000); },
        }),
        listDir: tool({
            description: 'List a directory of the repository.',
            inputSchema: jsonSchema({ type: 'object', properties: { path: { type: 'string' }, maxDepth: { type: 'number' } }, required: ['path'], additionalProperties: false }),
            execute: async ({ path: p, maxDepth }) => String(await cmd.listDir(p, maxDepth)).slice(0, 6000),
        }),
    };
}

// Claude por assinatura: a fachada do Agent SDK nao chama ferramenta; a sessao
// roda pelo proprio SDK com Read/Grep/Glob no worktree e o veredito em JSON no fim.
const PELO_SDK = require(path.join(INV, '..', 'shared', 'tier0-models')).TIER0[MODELO]?.provider === 'claude_agent_sdk';
async function julgaSdk(s, dir, cmd) {
    const { carregaSdk, envDoProcesso } = require(path.join(INV, 'claude-sdk-runner'));
    const sdk = await carregaSdk();
    const texto = comExtra(PROMPTS[arg('prompt', VERSAO)](s))
        .replace(/grep, readFile and listDir/g, 'Grep, Read and Glob')
        .replace('Answer with submit.', `End your answer with ONLY this JSON object, no code fence: {"verdict": ${JSON.stringify(VEREDITOS.join('|'))}, "evidence": "...", "reason": "..."}`);
    const z = sdk.z;
    const txt = (t) => ({ content: [{ type: 'text', text: String(t) }] });
    const extras = [
        ...(H3 ? [
            sdk.tool('readBaseFile', 'Read a file as it was BEFORE the pull request (base commit), optionally a line range.', { path: z.string(), startLine: z.number().optional(), endLine: z.number().optional() },
                async (a) => txt(await ferramentas(cmd).readBaseFile.execute(a))),
            sdk.tool('prDiff', 'Show the pull request diff of one file (or, with no path, the list of changed files).', { path: z.string().optional() }, async (a) => txt(prDiff(cmd, a.path))),
        ] : []),
        ...(H2 ? [sdk.tool('getCallers', 'List the call sites of a function or method in the repository call graph, marking callers that are tests.', { name: z.string() }, async (a) => txt(getCallers(cmd, a.name)))] : []),
        ...(H4 ? [sdk.tool('runSnippet', 'Run a small self-contained snippet in an isolated sandbox and return its exit code, stdout and stderr. No access to this repository.', { language: z.enum(['python', 'node', 'bash']), code: z.string() },
            async (a) => txt(await rodaTrecho(cmd, a.language, a.code)))] : []),
    ];
    let saida = '', turnos = 0;
    try {
        for await (const msg of sdk.query({
            prompt: texto,
            options: {
                model: require(path.join(INV, '..', 'shared', 'tier0-models')).TIER0[MODELO].sdkModel,
                systemPrompt: 'You can read the repository with the Read, Grep and Glob tools; your working directory is the repository at the pull request head.',
                tools: ['Read', 'Grep', 'Glob'], allowedTools: ['Read', 'Grep', 'Glob', ...extras.map((t) => `mcp__extra__${t.name}`)],
                ...(extras.length ? { mcpServers: { extra: sdk.createSdkMcpServer({ name: 'extra', version: '1', tools: extras }) } } : {}),
                disallowedTools: ['Bash', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task'],
                settingSources: [], cwd: dir, maxTurns: TETO, env: envDoProcesso(), ...(ESFORCO ? { effort: ESFORCO } : {}),
            },
        })) {
            if (msg.type === 'assistant') { turnos++; for (const b of msg.message.content || []) if (b.type === 'text') saida += b.text + '\n'; }
            if (msg.type === 'result' && msg.result) saida += '\n' + msg.result;
        }
    } catch (e) {
        if (!saida) throw e;
    }
    const d = extraiJson(saida);
    // Sem veredito ao bater o teto: mantem (unverified), como o passo final forcado faria.
    return { ...normaliza(d && VEREDITOS.includes(d.verdict) ? d : { verdict: 'unverified', evidence: '', reason: 'no verdict' }, s), passos: turnos };
}

async function julga(model, cmd, s, diff) {
    if (PELO_SDK) return julgaSdk(s, cmd.repoRoot, cmd);
    const schema = SCHEMA;
    let resp = null;
    const tools = {
        ...ferramentas(cmd),
        submit: tool({ description: 'Submit your answer. Call exactly once.', inputSchema: jsonSchema(schema), execute: async (x) => { resp = x; return 'recorded'; } }),
    };
    const r = await generateText({
        model, prompt: comExtra(PROMPTS[arg('prompt', VERSAO)](s, diff)), tools,
        ...(ESFORCO ? { providerOptions: { openaiCompatible: { reasoningEffort: ESFORCO } } } : {}),
        stopWhen: (x) => !!resp || (x.steps?.length ?? 0) >= TETO,
        prepareStep: ({ stepNumber, messages }) => stepNumber >= TETO - 1
            ? { activeTools: ['submit'], ...(semToolChoiceNomeado ? {} : { toolChoice: { type: 'tool', toolName: 'submit' } }),
                messages: [...messages, { role: 'user', content: 'This is your final step. Call submit now, from what you already know.' }] }
            : undefined,
    });
    return { ...normaliza(resp || extraiJson(r.text || ''), s), passos: r.steps?.length ?? 0 };
}

(async () => {
    const model = buildModel(MODELO);
    console.log(`[verify-alucinacao] ${VERSAO} · ${descreveModelo(MODELO)} · ${GOLD}`);
    const sug = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.json`), 'utf8')).prs;
    const fin = JSON.parse(fs.readFileSync(path.join(__dirname, '..', `${PREFIXO}_${GOLD}.final.json`), 'utf8')).prs;
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'dedup-real', DEDUP, `${GOLD}.json`), 'utf8')).prs;
    const vars = {};
    for (const f of fs.readdirSync(path.join(INV, 'datasets')).filter((x) => x.endsWith('.json'))) {
        try { const v = JSON.parse(fs.readFileSync(path.join(INV, 'datasets', f), 'utf8'))[0].vars; if (v?.caseId) vars[v.caseId] = v; } catch {}
    }
    const diffDe = (v) => { let a = v?.changedFilesFull; if (typeof a === 'string') a = JSON.parse(a); return (a || []).map((x) => `--- ${x.filename}\n${x.patchWithLinesStr || x.patch || ''}`).join('\n\n').slice(0, 40000); };
    const res = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : { model: GOLD, verificador: MODELO, versao: VERSAO, versaoDedup: DEDUP, prs: {} };
    const fila = Object.keys(sug).filter((c) => (!SO_PRS || SO_PRS.has(c)) && (!res.prs[c] || res.prs[c].erro));
    let i = 0;
    const um = async (cid) => {
        let h, cmdPr;
        try {
            const caiu = new Set(APOS ? (APOS[cid]?.grupos || []).filter((g) => g.nit).map((g) => g.rep) : []);
            const gs = grupos(sug[cid].suggestions, fin[cid], real[cid].idsEntradaDedup || []).filter((g) => !caiu.has(g.rep));
            const out = [];
            if (gs.length) {
                let cmd = null;
                {
                    h = await prepareRepo(vars[cid], `${cid}-nit-${process.pid}`);
                    if (!h) throw new Error('sem repo');
                    cmd = new LocalRepoCommands(h.dir);
                    cmdPr = cmd;
                    if (arg('base') === '1') cmd.baseRef = vars[cid].benchmarkBaseRef;
                    if (H2) cmd.grafo = carregaGrafo(vars[cid]);
                    if (H3) { cmd.headRef = vars[cid].benchmarkHeadRef; cmd.baseRef = vars[cid].benchmarkBaseRef || `${cmd.headRef}^`; }
                }
                const diff = '';
                let j = 0;
                await Promise.all(Array.from({ length: 4 }, async () => {
                    while (j < gs.length) {
                        const k = j++;
                        const v = await retry(() => julga(model, cmd, gs[k].s, diff));
                        out[k] = { rep: gs[k].rep, membros: gs[k].membros, ...v };
                    }
                }));
            }
            res.prs[cid] = { grupos: out };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} ${gs.length} comentarios, ${out.filter((x) => x.nit).length} nit`);
        } catch (e) {
            res.prs[cid] = { erro: String(e?.message || e).slice(0, 300) };
            console.log(`  ${cid.slice(0, 46).padEnd(48)} FALHOU: ${res.prs[cid].erro}`);
        } finally {
            if (cmdPr?.sandbox) await cmdPr.sandbox.kill().catch(() => {});
            if (h) await h.cleanup();
            fs.writeFileSync(OUT, JSON.stringify(res, null, 1));
        }
    };
    await Promise.all(Array.from({ length: PAR }, async () => { while (i < fila.length) await um(fila[i++]); }));
    const ok = Object.values(res.prs).filter((p) => !p.erro);
    const todos = ok.flatMap((p) => p.grupos);
    console.log(JSON.stringify({ versao: VERSAO, model: GOLD, prs: ok.length, erros: Object.keys(res.prs).length - ok.length, comentarios: todos.length, nit: todos.filter((x) => x.nit).length }));
    process.exit(Object.keys(res.prs).length - ok.length ? 2 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

async function retry(fn) { let u; for (let t = 0; t < 3; t++) { try { return await fn(); } catch (e) { u = e; await new Promise((ok) => setTimeout(ok, 8000 * 2 ** t)); } } throw u; }
