#!/usr/bin/env npx tsx
/**
 * E2B integration test for CodebaseSearchService.
 *
 * Tests the REAL production CodebaseSearchService against a real E2B sandbox
 * with the kodus-ai codebase, using known symbols with verifiable counts.
 *
 * Run:
 *   npx tsx test/integration/code-review/services/codebaseSearch.e2b.ts
 *
 * Requires:
 *   - API_E2B_KEY in .env or environment
 *   - GITHUB_TOKEN (optional, for private repo access)
 */

import * as dotenv from 'dotenv';
dotenv.config();

import { Sandbox } from 'e2b';
import { CodebaseSearchService } from '../../../../libs/code-review/infrastructure/adapters/services/codebaseSearch.service';
import type { RemoteCommands } from '../../../../libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

const REPO_DIR = '/home/user/repo';

//#region Test runner
let passed = 0;
let failed = 0;
const failures: string[] = [];

function assert(condition: boolean, message: string, detail?: string) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${message}`);
    } else {
        failed++;
        const fullMsg = detail ? `${message} — ${detail}` : message;
        failures.push(fullMsg);
        console.log(`  ✗ ${fullMsg}`);
    }
}
//#endregion

async function main() {
    const apiKey = process.env.API_E2B_KEY;
    if (!apiKey) {
        console.error('API_E2B_KEY not set. Skipping E2B integration tests.');
        process.exit(0);
    }

    // Use the REAL production service
    const service = new CodebaseSearchService();

    console.log('Creating E2B sandbox...');
    const sandbox = await Sandbox.create({ timeoutMs: 5 * 60 * 1000, apiKey });

    try {
        console.log('Installing git + ripgrep...');
        await sandbox.commands.run(
            'apt-get update -qq && apt-get install -y -qq git ripgrep > /dev/null 2>&1',
            { timeoutMs: 120_000, user: 'root' },
        );

        console.log('Cloning kodus-ai repo (shallow)...');
        const token = process.env.GITHUB_TOKEN || '';
        const authHeader = token
            ? `AUTHORIZATION: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`
            : '';
        const authArg = authHeader ? `-c http.extraHeader="${authHeader}"` : '';

        await sandbox.commands.run(
            [
                `git init ${REPO_DIR}`,
                `cd ${REPO_DIR}`,
                `git ${authArg} fetch --depth=1 https://github.com/kodustech/kodus-ai.git refs/heads/main:main`,
                `git checkout main`,
            ].join(' && '),
            { timeoutMs: 120_000 },
        );

        const remoteCommands: RemoteCommands = {
            grep: async (pattern, path, glob?) => {
                const fullPath = path.startsWith('/')
                    ? path
                    : `${REPO_DIR}/${path}`;
                const globArg = glob ? ` --glob '${glob}'` : '';
                const result = await sandbox.commands.run(
                    `rg --no-heading -n '${pattern.replace(/'/g, "'\\''")}' '${fullPath}'${globArg}`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
            },
            read: async (path, start, end) => {
                const fullPath = path.startsWith('/')
                    ? path
                    : `${REPO_DIR}/${path}`;
                const result = await sandbox.commands.run(
                    `sed -n '${start},${end}p' '${fullPath}'`,
                    { timeoutMs: 10_000 },
                );
                return result.stdout;
            },
            listDir: async (path, maxDepth) => {
                const fullPath = path.startsWith('/')
                    ? path
                    : `${REPO_DIR}/${path}`;
                const result = await sandbox.commands.run(
                    `find '${fullPath}' -maxdepth ${maxDepth} -type f`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout;
            },
        };

        const EXCLUDES = ['node_modules', '.git', 'dist', 'build'];

        // ─── Ground truth: get raw rg counts directly from sandbox ───────────
        console.log('\nGathering ground truth from sandbox...');

        // Ground truth: run rg -l directly on sandbox.
        // Uses --glob '!**/NAME/**' so exclude semantics match the service's
        // segment-based matchesExclude (matches "test" at ANY depth, not just root).
        // Extension globs like *.min.js are passed as --glob '!*.min.js'.
        async function countGrepFiles(
            pattern: string,
            glob: string,
            extraExcludes: string[] = [],
        ): Promise<string[]> {
            const allExcludes = [...EXCLUDES, ...extraExcludes];
            const excludeArgs = allExcludes
                .map((e) => {
                    if (e.startsWith('*.')) return `--glob '!${e}'`; // extension glob
                    if (e.endsWith('/')) return `--glob '!${e}**'`; // path prefix
                    return `--glob '!**/${e}/**' --glob '!${e}/**'`; // segment at any depth + root
                })
                .join(' ');
            try {
                const result = await sandbox.commands.run(
                    `cd ${REPO_DIR} && rg --no-heading -l --glob '${glob}' ${excludeArgs} '${pattern}'`,
                    { timeoutMs: 30_000 },
                );
                return result.stdout.trim().split('\n').filter(Boolean);
            } catch {
                return [];
            }
        }

        // Ground truth for isFileMatchingGlob
        const truthGlobFiles = await countGrepFiles(
            'isFileMatchingGlob',
            '**/*.ts',
            ['test', 'spec'],
        );
        console.log(
            `  Ground truth: isFileMatchingGlob in ${truthGlobFiles.length} files (excl test/spec)`,
        );

        // Ground truth for FileChange (with glob *.ts, excl test)
        const truthFileChangeFiles = await countGrepFiles(
            'FileChange',
            '**/*.ts',
            ['test', 'spec'],
        );
        console.log(
            `  Ground truth: FileChange in ${truthFileChangeFiles.length} files (excl test/spec)`,
        );

        // Ground truth for collectContexts\( callers
        const truthCollectCallers = await countGrepFiles(
            'collectContexts\\(',
            '**/*.ts',
            ['test', 'spec'],
        );
        console.log(
            `  Ground truth: collectContexts\\( in ${truthCollectCallers.length} files (excl test/spec)`,
        );

        // ═══════════════════════════════════════════════════════════════════════
        // 1. COMPLETENESS — compare service results against ground truth
        // ═══════════════════════════════════════════════════════════════════════
        console.log(
            '\n═══ 1. COMPLETENESS — service results vs ground truth ═══',
        );

        // isFileMatchingGlob: service should find ALL files that rg -l finds
        {
            const result = await service.search({
                query: 'isFileMatchingGlob',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(result.success, 'isFileMatchingGlob: search succeeds');
            const foundFiles = new Set(result.contexts.map((c) => c.file));

            // Must find the same count as ground truth (capped by maxFiles=20)
            const expectedCount = Math.min(truthGlobFiles.length, 20);
            assert(
                foundFiles.size === expectedCount,
                `isFileMatchingGlob: found ${foundFiles.size} files, ground truth ${truthGlobFiles.length} (cap 20 → expected ${expectedCount})`,
                foundFiles.size !== expectedCount
                    ? `missing: ${truthGlobFiles.filter((f) => !foundFiles.has(f)).join(', ')}`
                    : undefined,
            );

            // Verify specific known consumers by name
            const knownConsumers = [
                'github.service',
                'gitlab.service',
                'bitbucket.service',
                'fetch-changed-files.stage',
                'pullRequestManager.service',
                'kody-rules-validation.service',
            ];
            for (const name of knownConsumers) {
                const found = [...foundFiles].some((f) => f.includes(name));
                assert(
                    found,
                    `isFileMatchingGlob: contains ${name}`,
                    !found ? `files: ${[...foundFiles].join(', ')}` : undefined,
                );
            }
        }

        // FileChange: verify count matches ground truth (capped at 20)
        {
            const result = await service.search({
                query: 'FileChange',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
                maxFiles: 20,
            });
            assert(result.success, 'FileChange: search succeeds');
            const foundFiles = new Set(result.contexts.map((c) => c.file));
            const expectedCount = Math.min(truthFileChangeFiles.length, 20);
            assert(
                foundFiles.size === expectedCount,
                `FileChange: found ${foundFiles.size} files, ground truth ${truthFileChangeFiles.length} (cap 20 → expected ${expectedCount})`,
            );
        }

        // collectContexts\( callers: precise count
        {
            const result = await service.search({
                query: 'collectContexts\\(',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(result.success, 'collectContexts\\(: search succeeds');
            const foundFiles = new Set(result.contexts.map((c) => c.file));
            const expectedCount = Math.min(truthCollectCallers.length, 20);
            assert(
                foundFiles.size === expectedCount,
                `collectContexts\\(: found ${foundFiles.size} files, ground truth ${truthCollectCallers.length} (expected ${expectedCount})`,
                foundFiles.size !== expectedCount
                    ? `found: ${[...foundFiles].join(', ')}`
                    : undefined,
            );
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 2. CONTEXT QUALITY — content is useful for code review
        // ═══════════════════════════════════════════════════════════════════════
        console.log(
            '\n═══ 2. CONTEXT QUALITY — content is useful for code review ═══',
        );

        // FULL LOOP: cross-validate EVERY context from a broad multi-file search.
        // For each context the service returns, we:
        //   (a) re-read the same file range directly via sed — byte-for-byte comparison
        //   (b) verify the match line is at the correct position within the content
        //   (c) verify the content actually contains the search pattern
        //   (d) verify each file's content is unique (not reading same file twice)
        {
            const CONTEXT_LINES = 40;
            const SEARCH_PATTERN = 'isFileMatchingGlob';

            const result = await service.search({
                query: `${SEARCH_PATTERN}\\(`,
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
                contextLines: CONTEXT_LINES,
            });
            assert(result.success, 'content-loop: search succeeds');
            assert(
                result.contexts.length > 0,
                `content-loop: found ${result.contexts.length} context(s) across files`,
            );

            let byteMatchCount = 0;
            let lineAlignCount = 0;
            let patternPresentCount = 0;
            let hasFunctionContext = 0;

            for (const ctx of result.contexts) {
                const [matchStart, matchEnd] = ctx.lines[0];
                const readStart = Math.max(1, matchStart - CONTEXT_LINES);
                const readEnd = matchEnd + CONTEXT_LINES;

                // (a) Byte-for-byte comparison with direct file read
                const directContent = await remoteCommands.read(
                    ctx.file,
                    readStart,
                    readEnd,
                );
                if (ctx.content === directContent) {
                    byteMatchCount++;
                } else {
                    console.log(
                        `    ✗ MISMATCH ${ctx.file}:${matchStart} — service: ${ctx.content.length} chars, direct: ${directContent.length} chars`,
                    );
                }

                // (b) Verify match line is at the correct position within the content
                const contentLines = ctx.content.split('\n');
                const matchLineIndex = matchStart - readStart;
                if (
                    matchLineIndex >= 0 &&
                    matchLineIndex < contentLines.length &&
                    contentLines[matchLineIndex].includes(SEARCH_PATTERN)
                ) {
                    lineAlignCount++;
                } else {
                    console.log(
                        `    ✗ LINE MISALIGN ${ctx.file}:${matchStart} — index ${matchLineIndex}, line: "${(contentLines[matchLineIndex] || '').trim()}"`,
                    );
                }

                // (c) Content contains the pattern somewhere (even if line index is off)
                if (ctx.content.includes(SEARCH_PATTERN)) {
                    patternPresentCount++;
                } else {
                    console.log(`    ✗ PATTERN MISSING in ${ctx.file} content`);
                }

                // (d) Has surrounding code context (function/class/method — not just the match line)
                const contentLen = contentLines.length;
                if (
                    contentLen >= 20 &&
                    (ctx.content.includes('function') ||
                        ctx.content.includes('=>') ||
                        ctx.content.includes('async') ||
                        ctx.content.includes('class'))
                ) {
                    hasFunctionContext++;
                } else if (contentLen < 20) {
                    console.log(
                        `    ⚠ ${ctx.file}:${matchStart} — short context (${contentLen} lines), may be near file start/end`,
                    );
                }
            }

            const total = result.contexts.length;
            assert(
                byteMatchCount === total,
                `content-loop: ${byteMatchCount}/${total} contexts match direct read byte-for-byte`,
            );
            assert(
                lineAlignCount === total,
                `content-loop: ${lineAlignCount}/${total} contexts have match at correct line position`,
            );
            assert(
                patternPresentCount === total,
                `content-loop: ${patternPresentCount}/${total} contexts contain the search pattern`,
            );
            // Most contexts should have function/class context; a few may be type defs or interfaces
            assert(
                hasFunctionContext >= total * 0.8,
                `content-loop: ${hasFunctionContext}/${total} contexts include surrounding function/class code (≥80%)`,
            );

            // (e) Each file's content is unique — proves we're reading different files
            const uniqueContents = new Set(
                result.contexts.map((c) => c.content),
            );
            assert(
                uniqueContents.size === total,
                `content-loop: ${uniqueContents.size}/${total} contexts have unique content (no duplicates)`,
            );

            // Line numbers must be valid
            const allValidLines = result.contexts.every(
                (c) => c.lines[0][0] > 0 && c.lines[0][1] >= c.lines[0][0],
            );
            assert(
                allValidLines,
                'content-loop: all line ranges are valid (start > 0, end >= start)',
            );
        }

        // Same loop for a DIFFERENT pattern — multiple files, multiple ranges per file
        {
            const CONTEXT_LINES = 40;
            const SEARCH_PATTERN = 'PlatformType';

            const result = await service.search({
                query: SEARCH_PATTERN,
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
                contextLines: CONTEXT_LINES,
                maxFiles: 10,
            });
            assert(result.success, 'content-loop-2: search succeeds');
            assert(
                result.contexts.length >= 5,
                `content-loop-2: found ${result.contexts.length} contexts (PlatformType is widespread)`,
            );

            let byteOk = 0;
            let patternOk = 0;
            for (const ctx of result.contexts) {
                const [matchStart, matchEnd] = ctx.lines[0];
                const readStart = Math.max(1, matchStart - CONTEXT_LINES);
                const readEnd = matchEnd + CONTEXT_LINES;

                const directContent = await remoteCommands.read(
                    ctx.file,
                    readStart,
                    readEnd,
                );
                if (ctx.content === directContent) byteOk++;
                if (ctx.content.includes(SEARCH_PATTERN)) patternOk++;
            }

            const total = result.contexts.length;
            assert(
                byteOk === total,
                `content-loop-2: ${byteOk}/${total} byte-match (PlatformType across ${total} contexts)`,
            );
            assert(
                patternOk === total,
                `content-loop-2: ${patternOk}/${total} contain pattern`,
            );
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 3. PLANNER PATTERN TYPES — patterns the LLM planner actually generates
        // ═══════════════════════════════════════════════════════════════════════
        console.log(
            '\n═══ 3. PLANNER PATTERNS — patterns the LLM planner generates ═══',
        );

        // Type 1: function call-site with escaped parens
        {
            const result = await service.search({
                query: 'createSandboxWithRepo\\(',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(
                result.success,
                'call-site: createSandboxWithRepo\\( succeeds',
            );
            const files = [...new Set(result.contexts.map((c) => c.file))];
            assert(
                files.length >= 1,
                `call-site: found ${files.length} callers`,
            );
            // Should find the stage that calls it
            assert(
                files.some(
                    (f) =>
                        f.includes('collect-cross-file-context') ||
                        f.includes('codeAnalysis'),
                ),
                'call-site: found calling stage/orchestrator',
                `files: ${files.join(', ')}`,
            );
        }

        // Type 2: import-from pattern (Category 5 — upstream deps)
        {
            const result = await service.search({
                query: 'from.*e2bSandbox\\.service',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(result.success, 'import: from.*e2bSandbox.service succeeds');
            const files = [...new Set(result.contexts.map((c) => c.file))];
            assert(
                files.length >= 1,
                `import: found ${files.length} importers`,
            );
            assert(
                files.some((f) => f.includes('codebase.module')),
                'import: found codebase.module (module registration)',
                `files: ${files.join(', ')}`,
            );
        }

        // Type 3: constant reference (Category 4 — config/limits)
        {
            const result = await service.search({
                query: 'SANDBOX_TIMEOUT_MS',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(result.success, 'constant: SANDBOX_TIMEOUT_MS succeeds');
            assert(
                result.contexts.length >= 1,
                `constant: found ${result.contexts.length} usages`,
            );
            // Verify content actually shows the constant being used
            assert(
                result.contexts.some((c) =>
                    c.content.includes('SANDBOX_TIMEOUT_MS'),
                ),
                'constant: context text includes SANDBOX_TIMEOUT_MS',
            );
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 4. GLOB FILTERING — glob actually narrows results
        // ═══════════════════════════════════════════════════════════════════════
        console.log('\n═══ 4. GLOB FILTERING — glob narrows results ═══');

        {
            // Use a pattern common enough to exceed any file count, without maxFiles cap
            // Use isFileMatchingGlob which has ~10 files total
            const broad = await service.search({
                query: 'isFileMatchingGlob',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            const narrow = await service.search({
                query: 'isFileMatchingGlob',
                remoteCommands,
                includes: ['**/*.service.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
            });
            assert(
                broad.success && narrow.success,
                'glob filter: both succeed',
            );

            const broadFiles = new Set(broad.contexts.map((c) => c.file));
            const narrowFiles = new Set(narrow.contexts.map((c) => c.file));

            // Narrow MUST have strictly fewer files (we know stages use it too, which are .stage.ts not .service.ts)
            assert(
                narrowFiles.size < broadFiles.size,
                `glob filter: narrow (${narrowFiles.size}) < broad (${broadFiles.size})`,
                `narrow: ${[...narrowFiles].join(', ')} | broad: ${[...broadFiles].join(', ')}`,
            );

            // All narrow files should be *.service.ts
            const allService = [...narrowFiles].every((f) =>
                f.endsWith('.service.ts'),
            );
            assert(
                allService,
                'glob filter: all narrow results are *.service.ts',
                !allService
                    ? `non-service: ${[...narrowFiles].filter((f) => !f.endsWith('.service.ts')).join(', ')}`
                    : undefined,
            );

            // Broad should include .stage.ts files that narrow doesn't
            const hasStage = [...broadFiles].some((f) => f.includes('.stage.'));
            assert(
                hasStage,
                'glob filter: broad includes .stage.ts files that narrow excludes',
            );
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 5. MERGE & CONTEXT WINDOW — nearby matches merge, distant stay separate
        // ═══════════════════════════════════════════════════════════════════════
        console.log('\n═══ 5. MERGE & CONTEXT WINDOW ═══');

        {
            // PlatformType appears in e2bSandbox.service.ts in a switch statement (cases clustered)
            // AND at the top in imports (distant from switch)
            const result = await service.search({
                query: 'PlatformType',
                remoteCommands,
                includes: ['**/e2bSandbox.service.ts'],
                excludes: EXCLUDES,
            });
            assert(result.success, 'merge: search succeeds');

            // Get ground truth: how many individual rg lines match?
            const _rawMatchCount = await countGrepFiles(
                'PlatformType',
                '**/e2bSandbox.service.ts',
            );
            // With maxMatchesPerFile=5, we cap at 5 matches then merge
            // MERGE_GAP=10 means matches within 10 lines become one range
            // So we expect fewer contexts than raw match count
            assert(
                result.contexts.length > 0,
                `merge: found ${result.contexts.length} contexts`,
            );
            assert(
                result.contexts.length < 5,
                `merge: ${result.contexts.length} merged contexts < 5 (raw matches in file, merging worked)`,
            );

            // Each context should be substantial (multiple lines of surrounding code)
            for (let i = 0; i < result.contexts.length; i++) {
                const ctx = result.contexts[i];
                const lineCount = ctx.content.split('\n').length;
                assert(
                    lineCount >= 20,
                    `merge: context[${i}] has ${lineCount} lines (sufficient surrounding code)`,
                );
            }
        }

        // ═══════════════════════════════════════════════════════════════════════
        // 6. EDGE CASES
        // ═══════════════════════════════════════════════════════════════════════
        console.log('\n═══ 6. EDGE CASES ═══');

        // No matches → success: true, contexts: []
        {
            const result = await service.search({
                query: 'zzz_absolutely_nonexistent_pattern_zzz',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: EXCLUDES,
            });
            assert(
                result.success,
                'no match: returns success=true (not error)',
            );
            assert(
                result.contexts.length === 0,
                'no match: contexts is empty array',
            );
        }

        // Empty query → success: false with error
        {
            const result = await service.search({
                query: '',
                remoteCommands,
            });
            assert(!result.success, 'empty query: returns success=false');
            assert(
                result.error === 'Empty query',
                `empty query: error is "Empty query" (got "${result.error}")`,
            );
        }

        // Special regex characters in pattern (common in TS generics)
        {
            const result = await service.search({
                query: 'Map<string',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec'],
                maxFiles: 5,
            });
            assert(result.success, 'special chars: "Map<string" succeeds');
            assert(
                result.contexts.length > 0,
                `special chars: found ${result.contexts.length} contexts`,
            );
        }

        // Excludes: segment matching vs substring matching (the bug we fixed)
        // "test" must exclude "src/test/foo.ts" (segment match) but NOT "src/attest.ts" (substring)
        {
            // Step 1: search WITHOUT test/spec/evals exclude — find files including test dirs
            const withoutExclude = await service.search({
                query: 'describe\\(',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: EXCLUDES,
                maxFiles: 200,
            });
            assert(
                withoutExclude.success,
                'excludes-segment: base search succeeds',
            );
            const baseFiles = new Set(
                withoutExclude.contexts.map((c) => c.file),
            );

            // The base MUST contain some test/spec/evals files (prove pattern hits them)
            const baseTestFiles = [...baseFiles].filter((f) => {
                const segs = f.split('/');
                return segs.some(
                    (s) => s === 'test' || s === 'spec' || s === 'evals',
                );
            });
            assert(
                baseTestFiles.length > 0,
                `excludes-segment: base has ${baseTestFiles.length} test/spec/eval files (proves pattern exists there)`,
            );

            // Step 2: search WITH test/spec/evals exclude
            const withExclude = await service.search({
                query: 'describe\\(',
                remoteCommands,
                includes: ['**/*.ts'],
                excludes: [...EXCLUDES, 'test', 'spec', 'evals'],
                maxFiles: 200,
            });
            assert(
                withExclude.success,
                'excludes-segment: filtered search succeeds',
            );
            const filteredFiles = new Set(
                withExclude.contexts.map((c) => c.file),
            );

            // Filtered MUST have fewer files — the test files were actively removed
            assert(
                filteredFiles.size < baseFiles.size,
                `excludes-segment: filtered (${filteredFiles.size}) < base (${baseFiles.size})`,
                `excludes removed nothing?`,
            );

            // No file in filtered results should have test/spec/evals as a path SEGMENT
            const leaked = [...filteredFiles].filter((f) => {
                const segs = f.split('/');
                return segs.some(
                    (s) => s === 'test' || s === 'spec' || s === 'evals',
                );
            });
            assert(
                leaked.length === 0,
                `excludes-segment: 0 test/spec/eval segments in filtered results`,
                leaked.length > 0 ? `leaked: ${leaked.join(', ')}` : undefined,
            );

            // CRITICAL: files with "test" as SUBSTRING but not SEGMENT must NOT be excluded
            // e.g. "contest", "attest", "testing-utils", "latest"
            // This validates the matchesExclude fix (segment match, not substring)
            const substringNotSegment = [...baseFiles].filter((f) => {
                const segs = f.split('/');
                const hasSegment = segs.some((s) => s === 'test');
                const hasSubstring = f.toLowerCase().includes('test');
                return hasSubstring && !hasSegment;
            });
            if (substringNotSegment.length > 0) {
                const keptInFiltered = substringNotSegment.filter((f) =>
                    filteredFiles.has(f),
                );
                assert(
                    keptInFiltered.length === substringNotSegment.length,
                    `excludes-segment: ${keptInFiltered.length}/${substringNotSegment.length} substring-only files kept (not wrongly excluded)`,
                    `wrongly excluded: ${substringNotSegment.filter((f) => !filteredFiles.has(f)).join(', ')}`,
                );
            } else {
                console.log(
                    '    (no substring-only test files found — segment test is structural only)',
                );
            }
        }

        // Excludes: extension globs work (*.min.js, *.map)
        {
            const result = await service.search({
                query: 'function',
                remoteCommands,
                includes: ['**/*.js'],
                excludes: [...EXCLUDES, '*.min.js', '*.map'],
                maxFiles: 50,
            });
            assert(result.success, 'excludes-glob: search succeeds');
            const minFiles = result.contexts.filter(
                (c) => c.file.endsWith('.min.js') || c.file.endsWith('.map'),
            );
            assert(
                minFiles.length === 0,
                `excludes-glob: 0 .min.js/.map files in results`,
                minFiles.length > 0
                    ? `leaked: ${minFiles.map((c) => c.file).join(', ')}`
                    : undefined,
            );
        }

        // ═══════════════════════════════════════════════════════════════════════
        // Summary
        // ═══════════════════════════════════════════════════════════════════════
        console.log(`\n═══ Results: ${passed} passed, ${failed} failed ═══`);
        if (failures.length > 0) {
            console.log('\nFailures:');
            for (const f of failures) console.log(`  - ${f}`);
        }
        console.log('');
        if (failed > 0) process.exitCode = 1;
    } finally {
        console.log('Cleaning up sandbox...');
        await sandbox.kill();
    }
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
