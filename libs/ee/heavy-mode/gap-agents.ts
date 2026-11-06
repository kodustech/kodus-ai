/**
 * Enterprise Code — see `license_ee.md`. Experiment (exp/finder-gap-tools):
 * three heavy-mode agents aimed at the defect classes the 2026-11-05 study
 * found Kody missing — a reader outside the diff that the change breaks, a
 * sibling implementation left without the change, and logic that fails when
 * it is actually run. They run as heavy passes next to the M3 lenses, with the
 * lens prompt, their own tools and a larger step budget.
 */
import type { AgentTool, ToolResult } from '@libs/agent-harness/domain/contracts/tool.contract';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

import type { HeavyLens } from './heavy-lenses';

export const GAP_AGENT_MAX_FINDINGS = 4;

/** 12 steps, plus half a step per changed file above 8, at most 100. */
export function gapAgentMaxSteps(changedFiles: number): number {
    return Math.min(100, Math.floor(12 + Math.max(0, changedFiles - 8) * 0.5));
}

export const GAP_AGENT_SYSTEM_PROMPT = `You are a specialist code reviewer. You are given one class of defect to look for in one pull request, and the tools to investigate it, including tools made for this class. Investigate with the tools before deciding, and answer by calling the submitResult tool.`;

const WHO_READS = `- Readers of what this change altered. METHOD:
  1. From the diff, list the CONTRACTS this change alters: a field or property added, removed, renamed or given a new meaning; a status, enum or literal value added or removed; a function's return shape, nullability or error behaviour; a config key, environment variable, header, route, event, queue or column name; a value now written in another format or unit.
  2. For each contract, call findReaders with its name or literal to find where it is READ outside the lines this PR changed.
  3. Read each reader and decide whether it still works with the new contract: a filter or query that does not accept the new value, a mapper, entity or serializer that drops the new field, a consumer that still expects the old shape or error behaviour, a mirror (UI option list, schema, docs, another service) that lacks the new value, a writer and a reader using different names.
  Report the reader that breaks, anchored to the changed line that broke it, and name the reader's file and line in the text. Do not report a reader this PR already updated.`;

const SIBLINGS = `- A change made in one place and missing from its siblings. METHOD:
  1. For each changed file, and for the functions or classes the change touches, call findSiblings to list their parallel implementations: the other providers or platforms behind the same interface, base class or registry; other copies of a duplicated helper; the locales, stubs and fixtures that mirror it. Call getCallers on the changed functions to find the other entry points to the same use case (controller, CLI, MCP tool, cron, worker).
  2. State what this change fixes or adds: a guard, a scope or tenant check, a new field, a new error handling, a flag, a normalisation, a limit.
  3. Read each sibling and check whether it needed the same change and did not get it.
  Report the sibling left behind, anchored to the changed line whose change it lacks, and name the sibling's file and line in the text. Skip siblings this PR also changed the same way, and siblings whose difference is intended.`;

const CODE_EXEC = `- Logic that fails when it is actually run. METHOD:
  1. Pick the changed code whose correctness depends on concrete values rather than on wiring: a regex, a parser or formatter, string slicing, date or time arithmetic, rounding and units, sorting and comparison, normalisation (case, whitespace, unicode, paths, URLs), boundary conditions, a small algorithm, a check meant to block some input.
  2. Copy that logic into a standalone program and run it with runSnippet: the function body itself, with the project's imports replaced by minimal stubs. Run it on the inputs the change must handle: the normal case, empty and missing values, boundaries, unusual but valid inputs (other casing, unicode, a trailing slash, a leap day, a negative number, a very long value), and inputs an attacker controls. Print what it returns.
  3. Report a defect only when a run shows the code returning a wrong result, accepting what it must reject, or failing on an input it must handle; put the input and the observed output in the text.
  Write TypeScript as plain JavaScript. If the logic cannot be isolated from the project without guessing, skip it.`;

const FUZZ = `- Logic that breaks on inputs nobody thought of. METHOD:
  1. Pick the changed functions whose result depends on their input values: parsing and formatting, regex, slicing, arithmetic, dates, units, rounding, sorting, normalisation, validation, encoding, a small algorithm or state machine.
  2. Copy each into a standalone program with minimal stubs for the project's imports. When the PR changed an existing function, also rebuild its previous version from the diff's removed lines.
  3. Fuzz it with runSnippet, in the language of the code: javascript with fast-check (require('fast-check'); fc.assert(fc.property(...), { numRuns: 300 })), python with Hypothesis (@given, @settings(max_examples=300)), go with the standard library's testing/quick (fmt.Println(quick.Check(f, &quick.Config{MaxCount: 300}))), java with jqwik (a class Main whose @Property methods take @ForAll arguments; they run on their own), ruby with rantly (require 'rantly'; require 'rantly/property'; Rantly::Property.new(proc { ... }).check(300) { |x| raise "..." unless ... }). Generate the whole domain the callers can pass: empty, huge, negative, unicode, whitespace, separators, nested and duplicate values. Check one oracle per property:
     a. it must not throw, hang or return undefined/NaN on an input its callers can pass;
     b. where the PR did not mean to change the behaviour, the new version must return what the previous version returned;
     c. a property the function promises: format then parse gives the input back, applying it twice changes nothing, the output keeps the length, order or range it should.
  4. A failing property is shrunk to a minimal input. Before reporting, read the callers (getCallers, grep) and drop failures on inputs the callers can never pass and differences the PR intends.
  Report the minimal failing input, the output and what was expected, anchored to the changed line. Write TypeScript as plain JavaScript and Kotlin as Java. Skip logic that cannot be isolated without guessing.
  Only a property that a fuzzer run failed counts: if no fuzzer run in this review failed, every finding you submit is discarded. Do not report from reading alone. When the PR has no logic you can isolate, submit no findings.`;

/** The experiment's agents, as lenses: same prompt shape, own focus. */
export const GAP_AGENTS: Array<HeavyLens & { tools: 'readers' | 'siblings' | 'exec' | 'fuzz' }> = [
    {
        id: 'who-reads',
        label: 'bug',
        assignment: 'code outside the diff that reads what this change altered, and breaks with it',
        items: [],
        extraItems: [WHO_READS],
        tools: 'readers',
        reasoningExample:
            "The diff adds the status 'failed_assessment' at stage.ts:88. findReaders('failed_assessment') and findReaders('status') show cron.ts:475 filtering executions by status IN ('success','partial'). Read it: the cron never sees the new status, so the PR is never re-approved. Reported, anchored to stage.ts:88.",
    },
    {
        id: 'siblings',
        label: 'bug',
        assignment: 'parallel implementations that needed the same change and did not get it',
        items: [],
        extraItems: [SIBLINGS],
        tools: 'siblings',
        reasoningExample:
            'The diff adds a tenant check to update-rule.controller.ts:40. findSiblings on the use case shows mcp/tools/update-rule.tool.ts:22 calling the same use case. Read it: no tenant check. Reported, anchored to controller.ts:40, naming the MCP tool.',
    },
    {
        id: 'code-exec',
        label: 'bug',
        assignment: 'changed logic that returns a wrong result when it is run on the inputs it must handle',
        items: [],
        extraItems: [CODE_EXEC],
        tools: 'exec',
        reasoningExample:
            "The new regex at retry.ts:12 classifies 5xx errors. Ran it with runSnippet on 'model gpt-503-preview not found': it matched as TRANSIENT. A permanent error becomes retryable. Reported with the input and the output.",
    },
    {
        id: 'fuzz',
        label: 'bug',
        assignment: 'changed logic that a property-based fuzzer breaks on inputs its callers can pass',
        items: [],
        extraItems: [FUZZ],
        tools: 'fuzz',
        reasoningExample:
            "slugify() changed at slug.ts:20. Fuzzed new vs old with fast-check over fc.string(): for 'a\\u0301' the new version returns 'a-' where the old returned 'a'. getCallers shows titles from user input reach it. Reported with the minimal input and both outputs.",
    },
];

const EXCLUDES = [
    'node_modules',
    'vendor',
    'dist',
    'build',
    '.git',
    'coverage',
    '*.min.js',
    '*.lock',
    'package-lock.json',
    '*.map',
    '*.snap',
];
const MAX_LINES = 80;

const shellQuote = (s: string): string => `'${String(s).replace(/'/g, `'\\''`)}'`;
const ok = (output: string): ToolResult => ({ output });
const fail = (output: string): ToolResult => ({ output, isError: true });

async function run(remote: RemoteCommands, cmd: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (!remote.exec) return { stdout: '', stderr: 'exec unavailable', exitCode: 127 };
    return remote.exec(cmd);
}

const rgExcludes = EXCLUDES.map((g) => `--glob ${shellQuote(`!${g}`)}`).join(' ');

/** Classifies a matched line: a write (assignment, declaration, object key
 *  being set) or a read. Heuristic, for ranking only. */
function accessOf(line: string, term: string): 'write' | 'read' {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`${esc}\\s*(=(?!=)|:=|\\+=|-=)`).test(line)) return 'write';
    if (new RegExp(`(const|let|var|def|func|function|class|interface|type|enum)\\s+${esc}\\b`).test(line)) return 'write';
    return 'read';
}

export function buildFindReadersTool(remote: RemoteCommands, changedFiles: ReadonlySet<string>): AgentTool {
    return {
        name: 'findReaders',
        description:
            'Find where a name or literal (field, property, status value, enum member, env var, config key, column, route, event) is used across the repository, outside node_modules/vendor/build output. Returns file:line:text grouped by file, readers first, and marks files this PR changed. Use it for every contract the diff alters.',
        inputSchema: {
            type: 'object',
            properties: {
                term: { type: 'string', description: 'The exact name or literal, e.g. failed_assessment, astGraphStatus, API_LLM_PROVIDER.' },
                wholeWord: { type: 'boolean', description: 'Match whole words only (default true; set false for a literal with punctuation).' },
                path: { type: 'string', description: 'Limit the search to this folder (default: the whole repository).' },
            },
            required: ['term'],
        },
        async execute(input: unknown): Promise<ToolResult> {
            const { term, wholeWord = true, path } = (input ?? {}) as { term?: string; wholeWord?: boolean; path?: string };
            if (!term || term.length < 2) return fail('term is required (2+ characters)');
            const where = path && !path.includes('..') ? shellQuote(path.replace(/^\/+/, '')) : '.';
            const res = await run(remote, `rg -n --no-heading -F ${wholeWord ? '-w' : ''} ${rgExcludes} -- ${shellQuote(term)} ${where} 2>/dev/null | head -400`);
            const lines = (res.stdout || '').split('\n').filter(Boolean);
            if (!lines.length) return ok(`No use of "${term}" found.`);
            const byFile = new Map<string, string[]>();
            for (const l of lines) {
                const file = l.split(':')[0].replace(/^\.\//, '');
                (byFile.get(file) ?? byFile.set(file, []).get(file)!).push(l.replace(/^\.\//, ''));
            }
            const files = [...byFile.entries()].map(([file, hits]) => ({
                file,
                hits,
                reads: hits.filter((h) => accessOf(h.slice(h.indexOf(':', h.indexOf(':') + 1) + 1), term) === 'read').length,
                changed: changedFiles.has(file),
            }));
            files.sort((a, b) => Number(a.changed) - Number(b.changed) || b.reads - a.reads);
            const out: string[] = [`${lines.length}${lines.length >= 400 ? '+' : ''} uses of "${term}" in ${files.length} files.`];
            let budget = MAX_LINES;
            for (const f of files) {
                if (budget <= 0) {
                    out.push(`... ${files.length - files.indexOf(f)} more files`);
                    break;
                }
                out.push(`\n${f.file}${f.changed ? ' [changed in this PR]' : ''} (${f.reads} read, ${f.hits.length - f.reads} write)`);
                for (const h of f.hits.slice(0, Math.min(8, budget))) {
                    out.push(`  ${h.slice(0, 220)}`);
                    budget -= 1;
                }
            }
            return ok(out.join('\n'));
        },
    };
}

export function buildFindSiblingsTool(remote: RemoteCommands): AgentTool {
    return {
        name: 'findSiblings',
        description:
            'List the parallel implementations of a changed file or symbol: files of the same role in sibling folders or with the same suffix (other providers/platforms), classes implementing or extending the same interface or base class, and other definitions of the same function name. For the other entry points to the same use case, call getCallers on the changed function (the code graph of this review). Use it for each changed file and each changed function or class.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'A changed file, e.g. libs/platform/github/github.service.ts.' },
                symbol: { type: 'string', description: 'Optional: a changed function, method, class or interface name.' },
            },
            required: ['path'],
        },
        async execute(input: unknown): Promise<ToolResult> {
            const { path, symbol } = (input ?? {}) as { path?: string; symbol?: string };
            if (!path || path.includes('..')) return fail('path is required and must stay inside the repository');
            const file = path.replace(/^\/+/, '');
            const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '.';
            const base = file.slice(file.lastIndexOf('/') + 1);
            const parent = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '.';
            const suffix = base.includes('.') ? base.slice(base.indexOf('.')) : '';
            const sections: string[] = [];

            const sameRole = await run(
                remote,
                [
                    `find ${shellQuote(parent)} -mindepth 2 -maxdepth 3 -type f -name ${shellQuote(base)} -not -path ${shellQuote(`./${file}`)} -not -path ${shellQuote(file)} 2>/dev/null | head -30`,
                    suffix.length > 3
                        ? `find ${shellQuote(dir)} -maxdepth 1 -type f -name ${shellQuote(`*${suffix}`)} ! -name ${shellQuote(base)} 2>/dev/null | head -30`
                        : 'true',
                ].join('; '),
            );
            const roleFiles = [...new Set((sameRole.stdout || '').split('\n').filter(Boolean).map((l) => l.replace(/^\.\//, '')))];
            sections.push(roleFiles.length ? `Same role (sibling folders, same suffix):\n${roleFiles.map((f) => `  ${f}`).join('\n')}` : 'Same role: none found.');

            if (symbol && /^[A-Za-z_$][\w$]*$/.test(symbol)) {
                const impl = await run(
                    remote,
                    `rg -n --no-heading ${rgExcludes} -e ${shellQuote(`(implements|extends)\\s+[^{]*\\b${symbol}\\b`)} -e ${shellQuote(`class\\s+\\w+\\s*\\([^)]*\\b${symbol}\\b`)} -e ${shellQuote(`class\\s+\\w+\\s*<\\s*${symbol}\\b`)} . 2>/dev/null | head -40`,
                );
                const defs = await run(
                    remote,
                    `rg -n --no-heading ${rgExcludes} -e ${shellQuote(`(function|def|func|fn)\\s+${symbol}\\b`)} -e ${shellQuote(`^\\s*(public|private|protected|static|async|\\s)*${symbol}\\s*\\([^)]*\\)\\s*[:{]`)} . 2>/dev/null | head -40`,
                );
                const fmt = (s: string) => s.split('\n').filter(Boolean).map((l) => `  ${l.replace(/^\.\//, '').slice(0, 200)}`).join('\n');
                sections.push(impl.stdout?.trim() ? `Implementing or extending ${symbol}:\n${fmt(impl.stdout)}` : `Implementing or extending ${symbol}: none found.`);
                sections.push(defs.stdout?.trim() ? `Other definitions named ${symbol}:\n${fmt(defs.stdout)}` : `Other definitions named ${symbol}: none found.`);

            }
            return ok(sections.join('\n\n'));
        },
    };
}

/** The fuzzers on the benchmark exec template (e2b-sandbox/template.ts). */
export const FUZZ_LIB_DIR = '/opt/kodus-fuzz';

const RUNNERS: Record<string, { ext: string; cmd: (file: string) => string }> = {
    javascript: { ext: 'js', cmd: (f) => `node ${f}` },
    python: { ext: 'py', cmd: (f) => `python3 ${f}` },
    ruby: { ext: 'rb', cmd: (f) => `ruby ${f}` },
    go: { ext: 'go', cmd: (f) => `go run ${f}` },
    // A program with jqwik @Property methods runs through the JUnit console.
    java: {
        ext: 'java',
        cmd: (f) =>
            `sh -c 'if grep -q "@Property" ${f}; then CP=$(ls ${FUZZ_LIB_DIR}/java/*.jar | tr "\\n" ":"); javac -cp "$CP" -d . ${f} && java -jar ${FUZZ_LIB_DIR}/junit-console.jar execute -cp ".:$CP" --select-class Main --disable-banner --details=tree; else java ${f}; fi'`,
    },
};

/** What each fuzzer prints when a property fails: fast-check, Hypothesis,
 *  Go's testing/quick, jqwik, rantly. */
export const FUZZER_FAILURE = /Property failed after|Falsifying example|#\d+: failed on input|Property \[[^\]]*\] failed with sample|successful tests?, failed on:/;

export function buildRunSnippetTool(remote: RemoteCommands, onOutput?: (output: string) => void): AgentTool {
    let n = 0;
    return {
        name: 'runSnippet',
        description:
            'Run a short standalone program and return its output (stdout, stderr, exit code). Languages: javascript (write TypeScript as plain JavaScript), python, ruby, go, java. No project dependencies are installed: copy the logic under test into the program with minimal stubs. 30 s limit. Fuzzers: fast-check (javascript), Hypothesis (python), testing/quick (go), jqwik (java, @Property methods in class Main), rantly (ruby).',
        inputSchema: {
            type: 'object',
            properties: {
                language: { type: 'string', enum: Object.keys(RUNNERS) },
                code: { type: 'string', description: 'The whole program. It must print what you want to see.' },
            },
            required: ['language', 'code'],
        },
        async execute(input: unknown): Promise<ToolResult> {
            const { language, code } = (input ?? {}) as { language?: string; code?: string };
            const runner = language ? RUNNERS[language] : undefined;
            if (!runner) return fail(`language must be one of ${Object.keys(RUNNERS).join(', ')}`);
            if (!code?.trim()) return fail('code is required');
            n += 1;
            const dirName = `/tmp/kodus-run/s${n}`;
            const file = `${dirName}/${language === 'java' ? 'Main' : 'main'}.${runner.ext}`;
            const b64 = Buffer.from(code, 'utf8').toString('base64');
            const res = await run(
                remote,
                `mkdir -p ${dirName} && cd ${dirName} && echo ${shellQuote(b64)} | base64 -d > ${file} && env -i PATH=/usr/local/bin:/usr/bin:/bin:/usr/lib/go/bin NODE_PATH=${FUZZ_LIB_DIR}/node_modules PYTHONPATH=${FUZZ_LIB_DIR}/py HOME=${dirName} GOCACHE=${dirName}/.gocache GOFLAGS=-mod=mod timeout 30 ${runner.cmd(file)} 2>&1; echo "__EXIT=$?"`,
            );
            const out = res.stdout || res.stderr || '';
            const exit = /__EXIT=(\d+)/.exec(out)?.[1] ?? String(res.exitCode);
            const body = out.replace(/__EXIT=\d+\s*$/, '').trimEnd();
            onOutput?.(body);
            return ok(`exit code ${exit}${exit === '124' ? ' (timed out after 30 s)' : ''}\n${body.slice(0, 4000) || '(no output)'}`);
        },
    };
}

/** Whether the sandbox can run a program (production's E2B; the local
 *  sandbox only runs read-only programs). */
export async function sandboxCanRun(remote: RemoteCommands | undefined): Promise<boolean> {
    if (!remote?.exec) return false;
    try {
        const r = await remote.exec(`python3 -c 'print(6*7)'`);
        return (r.stdout || '').trim() === '42';
    } catch {
        return false;
    }
}
