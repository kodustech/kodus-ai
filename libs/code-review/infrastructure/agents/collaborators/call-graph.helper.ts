import { createLogger } from '@libs/core/log/logger';
import { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';
import {
    extractContentWindow,
    extractModifiedFunctionNames,
    generateCallGraphGrep,
    readSnippetWindow,
    MAX_CALLERS_PER_FUNCTION,
    MAX_CALLGRAPH_CHARS,
} from './repo-slices';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('CallGraphHelper');
const MAX_FUNCTIONS = 50;
const MAX_CALLERS = 5;
const MAX_CALLEES = 3;
const MAX_ASSEMBLED_CONTEXT_CHARS = 9000;
const MAX_ASSEMBLED_FUNCTIONS = 8;
const MAX_ASSEMBLED_CALLERS = 3;
const MAX_ASSEMBLED_CALLEES = 2;
const CHANGED_SNIPPET_RADIUS = 10;
const RELATED_SNIPPET_RADIUS = 8;

interface CallGraphEntry {
    name: string;
    short_name: string;
    parent: string;
    file: string;
    line: number;
    language: string;
    callers: Array<{
        file: string;
        line: number;
        name?: string;
        caller_file?: string;
    }>;
    callees?: Array<{
        name: string;
        file: string;
        line: number;
    }>;
}

type CallGraphData = Record<string, CallGraphEntry>;

const astCache = new Map<string, CallGraphData | null>();

function loadCallGraphJSON(repoKey: string): CallGraphData | null {
    if (astCache.has(repoKey)) return astCache.get(repoKey)!;

    const jsonPath = path.join(
        resolveCallGraphDir(),
        repoKey,
        'call-graph.json',
    );
    try {
        if (!fs.existsSync(jsonPath)) {
            logger.log({
                message: `[CALL-GRAPH] AST JSON not found: ${jsonPath}`,
                context: 'CallGraphHelper',
            });
            astCache.set(repoKey, null);
            return null;
        }

        const data = JSON.parse(
            fs.readFileSync(jsonPath, 'utf8'),
        ) as CallGraphData;
        astCache.set(repoKey, data);
        return data;
    } catch (err) {
        logger.warn({
            message: `[CALL-GRAPH] Failed to load AST JSON: ${jsonPath}`,
            context: 'CallGraphHelper',
            error: err,
        });
        astCache.set(repoKey, null);
        return null;
    }
}

function isTestLikePath(filePath: string): boolean {
    const lower = filePath.toLowerCase();
    return (
        lower.includes('/test') ||
        lower.includes('/tests') ||
        lower.includes('/spec') ||
        lower.includes('__tests__') ||
        lower.endsWith('_test.go') ||
        lower.endsWith('_test.py') ||
        lower.endsWith('.spec.ts') ||
        lower.endsWith('.spec.tsx') ||
        lower.endsWith('.test.ts') ||
        lower.endsWith('.test.tsx') ||
        lower.endsWith('.spec.js') ||
        lower.endsWith('.test.js')
    );
}

function truncateText(text: string, maxChars: number): string {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return text.substring(0, maxChars) + '\n... (truncated)';
}

function generateCallGraphFromAST(
    repositoryFullName: string,
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
    }>,
): string | null {
    const repoKey = resolveRepoKey(repositoryFullName);
    if (!repoKey) return null;

    const data = loadCallGraphJSON(repoKey);
    if (!data) return null;

    const modifiedFunctions = extractModifiedFunctionNames(changedFiles);
    if (modifiedFunctions.length === 0) return null;

    const byShortName = new Map<string, CallGraphEntry[]>();
    for (const entry of Object.values(data)) {
        const shortName = entry.short_name || entry.name;
        const list = byShortName.get(shortName) || [];
        list.push(entry);
        byShortName.set(shortName, list);
    }

    const entries: string[] = [];

    for (const func of modifiedFunctions) {
        let entry: CallGraphEntry | undefined;
        const candidates = byShortName.get(func.name) || [];
        entry = candidates.find((candidate) =>
            func.file.endsWith(candidate.file),
        );

        if (!entry && candidates.length > 0 && candidates.length <= 5) {
            entry = candidates[0];
        }

        const shortFile = func.file.split('/').slice(-2).join('/');

        if (!entry || entry.callers.length === 0) {
            const displayName = entry ? entry.name : func.name;
            const calleeLines = (entry?.callees || [])
                .slice(0, 5)
                .map((callee) => {
                    const calleeShort = callee.file
                        .split('/')
                        .slice(-2)
                        .join('/');
                    return `  → calls: ${callee.name} (${calleeShort}:${callee.line})`;
                });
            const calleeSection =
                calleeLines.length > 0 ? '\n' + calleeLines.join('\n') : '';
            entries.push(
                `${displayName} (${shortFile}:${func.line})\n  (no callers — interface impl or new function)${calleeSection}`,
            );
            continue;
        }

        const callerLines = entry.callers
            .slice(0, MAX_CALLERS_PER_FUNCTION)
            .map((caller) => {
                const callerShort = caller.file.split('/').slice(-2).join('/');
                const callerName = caller.name ? ` (${caller.name})` : '';
                return `  ← ${callerShort}:${caller.line}${callerName}`;
            });

        const calleeLines = (entry.callees || []).slice(0, 5).map((callee) => {
            const calleeShort = callee.file.split('/').slice(-2).join('/');
            return `  → calls: ${callee.name} (${calleeShort}:${callee.line})`;
        });

        const calleeSection =
            calleeLines.length > 0 ? '\n' + calleeLines.join('\n') : '';
        entries.push(
            `${entry.name} (${shortFile}:${func.line})\n${callerLines.join('\n')}${calleeSection}`,
        );
    }

    if (entries.length === 0) return null;

    let result =
        'Changed functions and their production callers (AST):\n\n' +
        entries.join('\n\n');

    if (result.length > MAX_CALLGRAPH_CHARS) {
        result = result.substring(0, MAX_CALLGRAPH_CHARS) + '\n... (truncated)';
    }

    return result;
}

export async function generateAssembledReviewContext(
    remoteCommands: RemoteCommands,
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
        fileContent?: string;
    }>,
    repositoryFullName?: string,
): Promise<string> {
    if (!repositoryFullName) return '';

    const repoKey = resolveRepoKey(repositoryFullName);
    if (!repoKey) return '';

    const data = loadCallGraphJSON(repoKey);
    if (!data) return '';

    const modifiedFunctions = extractModifiedFunctionNames(changedFiles).slice(
        0,
        MAX_ASSEMBLED_FUNCTIONS,
    );
    if (modifiedFunctions.length === 0) return '';

    const byShortName = new Map<string, CallGraphEntry[]>();
    for (const entry of Object.values(data)) {
        const shortName = entry.short_name || entry.name;
        const list = byShortName.get(shortName) || [];
        list.push(entry);
        byShortName.set(shortName, list);
    }

    const sections: string[] = [];

    for (const func of modifiedFunctions) {
        const candidates = byShortName.get(func.name) || [];
        let entry = candidates.find((candidate) =>
            func.file.endsWith(candidate.file),
        );
        if (!entry && candidates.length > 0 && candidates.length <= 5) {
            entry = candidates[0];
        }

        const changedFile = changedFiles.find(
            (file) => file.filename === func.file,
        );
        const changedSnippet =
            (await readSnippetWindow(
                remoteCommands,
                func.file,
                func.line,
                CHANGED_SNIPPET_RADIUS,
            )) ||
            extractContentWindow(
                changedFile?.fileContent || '',
                func.line,
                CHANGED_SNIPPET_RADIUS,
            ) ||
            'N/A';

        const callers = (entry?.callers || [])
            .filter((caller) => !isTestLikePath(caller.file))
            .slice(0, MAX_ASSEMBLED_CALLERS);
        const callees = (entry?.callees || [])
            .filter((callee) => !isTestLikePath(callee.file))
            .slice(0, MAX_ASSEMBLED_CALLEES);

        const callerBlocks = await Promise.all(
            callers.map(async (caller) => {
                const snippet = await readSnippetWindow(
                    remoteCommands,
                    caller.file,
                    caller.line,
                    RELATED_SNIPPET_RADIUS,
                );
                const shortFile = caller.file.split('/').slice(-3).join('/');
                const callerName = caller.name ? ` ${caller.name}` : '';
                return `- ${shortFile}:${caller.line}${callerName}\n\`\`\`\n${snippet || 'N/A'}\n\`\`\``;
            }),
        );

        const calleeBlocks = await Promise.all(
            callees.map(async (callee) => {
                const snippet = await readSnippetWindow(
                    remoteCommands,
                    callee.file,
                    callee.line,
                    RELATED_SNIPPET_RADIUS,
                );
                const shortFile = callee.file.split('/').slice(-3).join('/');
                return `- ${shortFile}:${callee.line} ${callee.name}\n\`\`\`\n${snippet || 'N/A'}\n\`\`\``;
            }),
        );

        const sectionLines = [
            `### ${entry?.name || func.name} (${func.file}:${func.line})`,
            'Changed snippet:',
            '```',
            changedSnippet,
            '```',
        ];

        if (callerBlocks.length > 0) {
            sectionLines.push('Likely callers:', ...callerBlocks);
        }

        if (calleeBlocks.length > 0) {
            sectionLines.push('Likely callees:', ...calleeBlocks);
        }

        sections.push(sectionLines.join('\n'));
    }

    if (sections.length === 0) return '';

    const assembled = truncateText(
        [
            'Pre-assembled AST context for changed symbols. Start here before opening more files.',
            'Use tools only to verify, disambiguate, or fetch missing context that is not already covered below.',
            '',
            ...sections,
        ].join('\n\n'),
        MAX_ASSEMBLED_CONTEXT_CHARS,
    );

    logger.log({
        message: `[CALL-GRAPH] assembled-context repo=${repositoryFullName} chars=${assembled.length} symbols=${sections.length}`,
        context: 'CallGraphHelper',
        metadata: {
            repositoryFullName,
            chars: assembled.length,
            symbols: sections.length,
            preview: assembled.substring(0, 280),
        },
    });

    return assembled;
}

export async function generateCallGraph(
    remoteCommands: RemoteCommands,
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
    }>,
    repositoryFullName?: string,
): Promise<string> {
    if (repositoryFullName) {
        try {
            const astResult = generateCallGraphFromAST(
                repositoryFullName,
                changedFiles,
            );
            if (astResult) {
                logger.log({
                    message: `[CALL-GRAPH] source=ast repo=${repositoryFullName} chars=${astResult.length} changedFiles=${changedFiles.length}`,
                    context: 'CallGraphHelper',
                    metadata: {
                        repositoryFullName,
                        source: 'ast',
                        changedFiles: changedFiles.length,
                        chars: astResult.length,
                        preview: astResult.substring(0, 280),
                    },
                });
                return astResult;
            }
        } catch (err) {
            logger.warn({
                message: `[CALL-GRAPH] AST lookup failed, falling back to grep`,
                context: 'CallGraphHelper',
                error: err,
            });
        }
    }

    const grepResult = await generateCallGraphGrep(
        remoteCommands,
        changedFiles,
    );

    if (grepResult) {
        logger.log({
            message: `[CALL-GRAPH] source=grep repo=${repositoryFullName || 'unknown'} chars=${grepResult.length} changedFiles=${changedFiles.length}`,
            context: 'CallGraphHelper',
            metadata: {
                repositoryFullName,
                source: 'grep',
                changedFiles: changedFiles.length,
                chars: grepResult.length,
                preview: grepResult.substring(0, 280),
            },
        });
    } else {
        logger.warn({
            message: `[CALL-GRAPH] source=none repo=${repositoryFullName || 'unknown'} generated no call graph`,
            context: 'CallGraphHelper',
            metadata: {
                repositoryFullName,
                sourceTried: repositoryFullName ? ['ast', 'grep'] : ['grep'],
                changedFiles: changedFiles.length,
            },
        });
    }

    return grepResult;
}

// ---------------------------------------------------------------------------
// JSON fallback — reads pre-computed call-graph.json when sandbox build fails
// ---------------------------------------------------------------------------

const REPO_NAME_MAP: Record<string, string> = {
    'sentry': 'sentry',
    'sentry-greptile': 'sentry',
    'grafana': 'grafana',
    'grafana-codex': 'grafana',
    'grafana-greptile': 'grafana',
    'discourse': 'discourse',
    'discourse-cursor': 'discourse',
    'discourse-greptile': 'discourse',
    'cal.com': 'calcom',
    'calcom': 'calcom',
    'cal-com': 'calcom',
    'cal.com-greptile': 'calcom',
    'keycloak': 'keycloak',
    'keycloak-greptile': 'keycloak',
};

function resolveCallGraphDir(): string {
    return (
        process.env.CALLGRAPH_DIR || path.resolve(process.cwd(), 'callgraph')
    );
}

function resolveRepoKey(repositoryFullName: string): string | null {
    const repoName = repositoryFullName.split('/').pop() || '';
    return (
        REPO_NAME_MAP[repoName] || REPO_NAME_MAP[repoName.toLowerCase()] || null
    );
}

/**
 * Fallback: generate call graph text from pre-computed JSON files.
 * Used when the sandbox-based code-review-graph build is not available.
 */
export function generateCallGraphFromJSON(
    changedFiles: Array<{
        filename: string;
        patch?: string;
        patchWithLinesStr?: string;
    }>,
    repositoryFullName?: string,
): string {
    if (!repositoryFullName || !changedFiles?.length) return '';

    const repoKey = resolveRepoKey(repositoryFullName);
    if (!repoKey) return '';

    const jsonPath = path.join(
        resolveCallGraphDir(),
        repoKey,
        'call-graph.json',
    );
    if (!fs.existsSync(jsonPath)) return '';

    try {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8')) as Record<
            string,
            any
        >;

        // Find functions in changed files
        const changedPaths = new Set(changedFiles.map((f) => f.filename));
        const matchedFunctions: any[] = [];

        for (const entry of Object.values(data)) {
            const entryFile = entry.file || '';
            // Match if changed file path ends with the entry file or vice versa
            const matches = [...changedPaths].some(
                (cf) => cf.endsWith(entryFile) || entryFile.endsWith(cf),
            );
            if (matches && entry.kind === 'Function') {
                matchedFunctions.push(entry);
            }
        }

        if (matchedFunctions.length === 0) return '';

        // Format with types
        const sections: string[] = [];
        const seen = new Set<string>();

        for (const fn of matchedFunctions.slice(0, MAX_FUNCTIONS)) {
            const key = `${fn.name}:${fn.file}:${fn.line}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const shortFile = (fn.file || '').split('/').slice(-2).join('/');
            const sig = fn.params
                ? `${fn.short_name || fn.name}${fn.params}`
                : fn.short_name || fn.name;
            const ret = fn.returnType ? ` -> ${fn.returnType}` : '';

            const lines: string[] = [`${sig}${ret}  (${shortFile}:${fn.line})`];

            // Callers
            const callers = fn.callers || [];
            if (callers.length === 0) {
                lines.push('  (no production callers found)');
            } else {
                for (const c of callers.slice(0, MAX_CALLERS)) {
                    const callerShort = (c.file || '')
                        .split('/')
                        .slice(-2)
                        .join('/');
                    lines.push(
                        `  ← called by ${c.name} (${callerShort}:${c.line})`,
                    );
                }
            }

            // Callees
            const callees = fn.callees || [];
            for (const c of callees.slice(0, MAX_CALLEES)) {
                const calleeShort = (c.file || c.file_path || '')
                    .split('/')
                    .slice(-2)
                    .join('/');
                const calleeSig = c.params ? `${c.name}${c.params}` : c.name;
                const calleeRet =
                    c.returnType || c.return_type
                        ? ` -> ${c.returnType || c.return_type}`
                        : '';
                lines.push(
                    `  → calls ${calleeSig}${calleeRet}  (${calleeShort}:${c.line || c.line_start || '?'})`,
                );
            }

            sections.push(lines.join('\n'));
        }

        let result =
            'Changed functions and their production callers (AST):\n\n' +
            sections.join('\n\n');

        if (result.length > MAX_CALLGRAPH_CHARS) {
            result =
                result.substring(0, MAX_CALLGRAPH_CHARS) + '\n... (truncated)';
        }

        logger.log({
            message: `[CALL-GRAPH-JSON] Generated ${result.length} chars from JSON fallback (${matchedFunctions.length} functions)`,
            context: 'CallGraphHelper',
        });

        return result;
    } catch (err) {
        logger.warn({
            message: `[CALL-GRAPH-JSON] Failed to read ${jsonPath}: ${err instanceof Error ? err.message : String(err)}`,
            context: 'CallGraphHelper',
        });
        return '';
    }
}
