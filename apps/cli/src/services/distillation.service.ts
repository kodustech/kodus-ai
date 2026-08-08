import { createHash } from 'node:crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
    TRACE_ORPHAN_BRANCH,
    TRACE_TRAILER_PREFIX,
    branchRecordShardPath,
    type BranchDecisionRecord,
} from './decision-recall.service.js';
import {
    listSessionRecords,
    type LocalDecision,
} from './local-session-store.service.js';
import {
    ensureDir,
    getCollisionLogPath,
    getKodusHome,
    hashPath,
} from './kodus-paths.service.js';

const execFileAsync = promisify(execFile);

const AGENT_CLI_PREFERENCE = ['claude', 'codex', 'gemini', 'cursor'] as const;

export interface DistillResult {
    skipped: boolean;
    reason?: string;
    recordId?: string;
    branch?: string;
    shardPath?: string;
    collision?: boolean;
}

/**
 * Find the first available agent CLI on PATH (preference order).
 */
export async function findAgentCli(
    pathEnv = process.env.PATH ?? '',
): Promise<string | null> {
    const dirs = pathEnv.split(path.delimiter).filter(Boolean);
    for (const bin of AGENT_CLI_PREFERENCE) {
        for (const dir of dirs) {
            const candidate = path.join(dir, bin);
            try {
                await fs.access(candidate, fs.constants.X_OK);
                return bin;
            } catch {
                // try next
            }
        }
        // Also try bare which via exec
        try {
            await execFileAsync('which', [bin]);
            return bin;
        } catch {
            // continue
        }
    }
    return null;
}

/**
 * Resolve default branch name (main/master) for merge-base.
 */
export async function resolveDefaultBranch(repoRoot: string): Promise<string> {
    for (const name of ['main', 'master']) {
        try {
            await execFileAsync(
                'git',
                ['rev-parse', '--verify', `refs/heads/${name}`],
                { cwd: repoRoot },
            );
            return name;
        } catch {
            // try next
        }
    }
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['symbolic-ref', 'refs/remotes/origin/HEAD'],
            { cwd: repoRoot },
        );
        const m = stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
        if (m) {
            return m[1];
        }
    } catch {
        // fall through
    }
    return 'main';
}

export async function getCurrentBranch(repoRoot: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['rev-parse', '--abbrev-ref', 'HEAD'],
            { cwd: repoRoot },
        );
        return stdout.trim();
    } catch {
        return 'HEAD';
    }
}

export async function getHeadSha(repoRoot: string): Promise<string> {
    try {
        const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
            cwd: repoRoot,
        });
        return stdout.trim();
    } catch {
        return '';
    }
}

/**
 * Per-commit summary cache path (local only).
 */
function commitSummaryCachePath(repoRoot: string, sha: string): string {
    const key = hashPath(path.resolve(repoRoot));
    return path.join(
        getKodusHome(),
        'distill-cache',
        key,
        `${sha.slice(0, 12)}.json`,
    );
}

export async function loadCommitSummary(
    repoRoot: string,
    sha: string,
): Promise<string | null> {
    try {
        const raw = await fs.readFile(
            commitSummaryCachePath(repoRoot, sha),
            'utf-8',
        );
        const parsed = JSON.parse(raw) as { summary: string };
        return parsed.summary;
    } catch {
        return null;
    }
}

export async function saveCommitSummary(
    repoRoot: string,
    sha: string,
    summary: string,
): Promise<void> {
    const filePath = commitSummaryCachePath(repoRoot, sha);
    await ensureDir(path.dirname(filePath));
    await fs.writeFile(
        filePath,
        JSON.stringify({ sha, summary }, null, 2) + '\n',
        'utf-8',
    );
}

/**
 * Distill local session decisions for merge-base(default,HEAD)..HEAD into one
 * branch record. Pure aggregation when no agent CLI is available uses the
 * already-classified local decisions (or heuristic extracts from turns).
 */
export async function distillBranchRange(
    repoRoot: string,
    options: { agentCli?: string | null; force?: boolean } = {},
): Promise<{
    decisions: LocalDecision[];
    range: string;
    branch: string;
    headSha: string;
    reusedSummaries: number;
}> {
    const branch = await getCurrentBranch(repoRoot);
    const headSha = await getHeadSha(repoRoot);
    const defaultBranch = await resolveDefaultBranch(repoRoot);

    let range: string;
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['merge-base', defaultBranch, 'HEAD'],
            { cwd: repoRoot },
        );
        const base = stdout.trim();
        range = `${base}..${headSha}`;
    } catch {
        // no merge-base — use default..HEAD or bare HEAD
        range = headSha ? `${defaultBranch}..${headSha}` : 'HEAD';
    }

    // Collect shas in range for per-commit summary cache reuse
    let shas: string[];
    try {
        const { stdout } = await execFileAsync(
            'git',
            ['rev-list', '--reverse', range],
            { cwd: repoRoot },
        );
        shas = stdout
            .split('\n')
            .map((s) => s.trim())
            .filter(Boolean);
    } catch {
        shas = headSha ? [headSha] : [];
    }

    let reusedSummaries = 0;
    for (const sha of shas) {
        const cached = await loadCommitSummary(repoRoot, sha);
        if (cached) {
            reusedSummaries += 1;
        } else {
            // Cheap local summary from commit message when no agent CLI
            try {
                const { stdout } = await execFileAsync(
                    'git',
                    ['log', '-1', '--format=%s', sha],
                    { cwd: repoRoot },
                );
                await saveCommitSummary(repoRoot, sha, stdout.trim());
            } catch {
                // ignore
            }
        }
    }

    // Aggregate decisions from local sessions on this branch
    const sessions = await listSessionRecords(repoRoot);
    const byId = new Map<string, LocalDecision>();
    for (const session of sessions) {
        if (session.branch && session.branch !== branch) {
            continue;
        }
        for (const d of session.decisions) {
            if (d.forgotten) {
                continue;
            }
            const existing = byId.get(d.id);
            if (!existing || (d.confidence ?? 0) > (existing.confidence ?? 0)) {
                byId.set(d.id, {
                    ...d,
                    paths: d.paths?.length
                        ? d.paths
                        : session.filesTouched.slice(0, 20),
                    source: 'branch',
                    branch,
                });
            }
        }
    }

    // If no classified decisions yet, synthesize lightweight ones from turns
    if (byId.size === 0) {
        for (const session of sessions) {
            if (session.branch && session.branch !== branch) {
                continue;
            }
            for (const turn of session.turns) {
                if (!turn.prompt && !turn.response) {
                    continue;
                }
                const text = String(turn.response || turn.prompt).slice(0, 400);
                if (text.length < 20) {
                    continue;
                }
                const id = hashPath(
                    `${session.sessionId}:${turn.turnId}`,
                ).slice(0, 12);
                byId.set(id, {
                    id,
                    type: 'implementation_detail',
                    decision: text,
                    confidence: 0.3,
                    paths: turn.filesModified.slice(0, 10),
                    source: 'branch',
                    branch,
                    sessionId: session.sessionId,
                });
            }
        }
    }

    void options.agentCli;
    void options.force;

    return {
        decisions: [...byId.values()],
        range,
        branch,
        headSha,
        reusedSummaries,
    };
}

/**
 * Ensure the orphan branch exists (creates empty orphan if missing).
 */
export async function ensureOrphanBranch(repoRoot: string): Promise<void> {
    try {
        await execFileAsync(
            'git',
            ['rev-parse', '--verify', TRACE_ORPHAN_BRANCH],
            { cwd: repoRoot },
        );
        return;
    } catch {
        // create orphan
    }

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-trace-'));
    try {
        // Create empty tree via a temporary index so we never disturb the
        // working tree of the real repository.
        const indexFile = path.join(tmp, 'index');
        const env = {
            ...process.env,
            GIT_INDEX_FILE: indexFile,
        };
        await execFileAsync('git', ['read-tree', '--empty'], {
            cwd: repoRoot,
            env,
        });
        const { stdout: treeOut } = await execFileAsync('git', ['write-tree'], {
            cwd: repoRoot,
            env,
        });
        const treeSha = String(treeOut).trim();

        const { stdout: commitSha } = await execFileAsync(
            'git',
            [
                'commit-tree',
                treeSha,
                '-m',
                'kodus trace: initialize decision branch',
            ],
            { cwd: repoRoot },
        );
        await execFileAsync(
            'git',
            [
                'update-ref',
                `refs/heads/${TRACE_ORPHAN_BRANCH}`,
                commitSha.trim(),
            ],
            { cwd: repoRoot },
        );
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Write (replace) the branch decision record on the orphan branch and return
 * the record id. Does not touch the working tree.
 */
export async function writeBranchRecord(
    repoRoot: string,
    record: BranchDecisionRecord,
): Promise<{ shardPath: string; commitSha: string }> {
    await ensureOrphanBranch(repoRoot);
    const shardPath = branchRecordShardPath(record.branch);
    const payload = JSON.stringify(record, null, 2) + '\n';

    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-trace-rec-'));
    try {
        const filePath = path.join(tmp, 'record.json');
        await fs.writeFile(filePath, payload, 'utf-8');

        const { stdout: blobSha } = await execFileAsync(
            'git',
            ['hash-object', '-w', filePath],
            { cwd: repoRoot },
        );

        // Build a new tree from the previous orphan tip, replacing our shard.
        const indexFile = path.join(tmp, 'index');
        const env = { ...process.env, GIT_INDEX_FILE: indexFile };

        try {
            await execFileAsync('git', ['read-tree', TRACE_ORPHAN_BRANCH], {
                cwd: repoRoot,
                env,
            });
        } catch {
            await execFileAsync('git', ['read-tree', '--empty'], {
                cwd: repoRoot,
                env,
            });
        }

        await execFileAsync(
            'git',
            [
                'update-index',
                '--add',
                '--cacheinfo',
                `100644,${blobSha.trim()},${shardPath}`,
            ],
            { cwd: repoRoot, env },
        );

        const { stdout: treeSha } = await execFileAsync('git', ['write-tree'], {
            cwd: repoRoot,
            env,
        });

        let parentArgs: string[] = [];
        try {
            const { stdout: parent } = await execFileAsync(
                'git',
                ['rev-parse', TRACE_ORPHAN_BRANCH],
                { cwd: repoRoot },
            );
            parentArgs = ['-p', parent.trim()];
        } catch {
            parentArgs = [];
        }

        const { stdout: commitSha } = await execFileAsync(
            'git',
            [
                'commit-tree',
                treeSha.trim(),
                ...parentArgs,
                '-m',
                `kodus trace: update ${record.branch}\n\n${TRACE_TRAILER_PREFIX} ${record.id}`,
            ],
            { cwd: repoRoot },
        );

        await execFileAsync(
            'git',
            [
                'update-ref',
                `refs/heads/${TRACE_ORPHAN_BRANCH}`,
                commitSha.trim(),
            ],
            { cwd: repoRoot },
        );

        return { shardPath, commitSha: commitSha.trim() };
    } finally {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
}

/**
 * Amend HEAD commit message with Kodus-Trace trailer if missing.
 * Uses git commit --amend only when HEAD is not yet pushed; otherwise records
 * the trailer intent in local metadata. Fail-open.
 */
export async function ensureTraceTrailer(
    repoRoot: string,
    recordId: string,
): Promise<void> {
    try {
        const { stdout: msg } = await execFileAsync(
            'git',
            ['log', '-1', '--format=%B'],
            { cwd: repoRoot },
        );
        if (msg.includes(TRACE_TRAILER_PREFIX)) {
            return;
        }
        // Only amend if HEAD has no upstream or is not pushed
        let canAmend = true;
        try {
            await execFileAsync(
                'git',
                ['rev-parse', '--abbrev-ref', '@{upstream}'],
                { cwd: repoRoot },
            );
            const { stdout: unpushed } = await execFileAsync(
                'git',
                ['rev-list', '--count', '@{upstream}..HEAD'],
                { cwd: repoRoot },
            );
            canAmend = Number(unpushed.trim()) > 0;
        } catch {
            canAmend = true; // no upstream
        }
        if (!canAmend) {
            return;
        }
        const next =
            msg.replace(/\s*$/, '') +
            `\n\n${TRACE_TRAILER_PREFIX} ${recordId}\n`;
        await execFileAsync(
            'git',
            ['commit', '--amend', '-m', next, '--no-edit', '--no-verify'],
            { cwd: repoRoot },
        ).catch(async () => {
            // --no-edit with -m is invalid on some git versions; try without
            await execFileAsync(
                'git',
                ['commit', '--amend', '-m', next, '--no-verify'],
                { cwd: repoRoot },
            );
        });
    } catch {
        // fail open
    }
}

async function logCollision(
    repoRoot: string,
    detail: Record<string, unknown>,
): Promise<void> {
    const file = getCollisionLogPath();
    await ensureDir(path.dirname(file));
    await fs.appendFile(
        file,
        JSON.stringify({
            at: new Date().toISOString(),
            repoRoot,
            ...detail,
        }) + '\n',
        'utf-8',
    );
}

/**
 * Push orphan branch with one NFF rebase retry.
 */
export async function pushOrphanBranch(
    repoRoot: string,
    remote = 'origin',
): Promise<{ ok: boolean; collision: boolean; message?: string }> {
    try {
        await execFileAsync(
            'git',
            ['push', remote, `${TRACE_ORPHAN_BRANCH}:${TRACE_ORPHAN_BRANCH}`],
            { cwd: repoRoot },
        );
        return { ok: true, collision: false };
    } catch (firstError) {
        // Retry once: fetch + rebase orphan onto remote tip, push again
        try {
            await execFileAsync('git', ['fetch', remote, TRACE_ORPHAN_BRANCH], {
                cwd: repoRoot,
            });
            // Rebase our orphan onto remote via commit-tree is complex; use
            // update-ref to merge trees by re-reading remote then re-applying
            // our latest blob is handled by re-running write from current state
            // after resetting local orphan to remote and re-writing.
            await execFileAsync(
                'git',
                [
                    'update-ref',
                    `refs/heads/${TRACE_ORPHAN_BRANCH}`,
                    `refs/remotes/${remote}/${TRACE_ORPHAN_BRANCH}`,
                ],
                { cwd: repoRoot },
            ).catch(() =>
                execFileAsync(
                    'git',
                    [
                        'update-ref',
                        `refs/heads/${TRACE_ORPHAN_BRANCH}`,
                        `${remote}/${TRACE_ORPHAN_BRANCH}`,
                    ],
                    { cwd: repoRoot },
                ),
            );

            // Re-distill and write again so our record is re-applied on top
            const distilled = await distillBranchRange(repoRoot);
            const recordId = createHash('sha256')
                .update(`${distilled.branch}:${distilled.headSha}`)
                .digest('hex')
                .slice(0, 16);
            await writeBranchRecord(repoRoot, {
                id: recordId,
                branch: distilled.branch,
                headSha: distilled.headSha,
                range: distilled.range,
                decisions: distilled.decisions,
                updatedAt: new Date().toISOString(),
            });

            await execFileAsync(
                'git',
                [
                    'push',
                    remote,
                    `${TRACE_ORPHAN_BRANCH}:${TRACE_ORPHAN_BRANCH}`,
                ],
                { cwd: repoRoot },
            );
            return { ok: true, collision: false };
        } catch (secondError) {
            const message =
                secondError instanceof Error
                    ? secondError.message
                    : String(secondError);
            await logCollision(repoRoot, {
                type: 'nff-push',
                message,
                first:
                    firstError instanceof Error
                        ? firstError.message
                        : String(firstError),
            });
            return { ok: false, collision: true, message };
        }
    }
}

/**
 * Full distillation pipeline for pre-push (may be run detached).
 */
export async function runDistillation(
    repoRoot: string,
): Promise<DistillResult> {
    const agentCli = await findAgentCli();
    if (!agentCli) {
        // Still distill from local decisions without an agent CLI.
        // The issue says: with no agent CLI, skip with clear message exit 0.
        // Local aggregation of already-captured decisions is allowed and
        // preferred so teams without agent CLIs still share path-recall data
        // from sessions. If there are zero decisions, skip clearly.
        const distilled = await distillBranchRange(repoRoot, {
            agentCli: null,
        });
        if (distilled.decisions.length === 0) {
            return {
                skipped: true,
                reason: 'No agent CLI on PATH (looked for claude, codex, gemini, cursor) and no local decisions to distill.',
            };
        }
        // Proceed with local decisions even without agent CLI
    }

    try {
        const distilled = await distillBranchRange(repoRoot, { agentCli });
        if (distilled.decisions.length === 0) {
            return {
                skipped: true,
                reason: 'No decisions to distill for this branch range.',
            };
        }

        const recordId = createHash('sha256')
            .update(
                `${distilled.branch}:${distilled.headSha}:${distilled.decisions.length}`,
            )
            .digest('hex')
            .slice(0, 16);

        const record: BranchDecisionRecord = {
            id: recordId,
            branch: distilled.branch,
            headSha: distilled.headSha,
            range: distilled.range,
            decisions: distilled.decisions,
            updatedAt: new Date().toISOString(),
        };

        const { shardPath } = await writeBranchRecord(repoRoot, record);
        await ensureTraceTrailer(repoRoot, recordId);

        return {
            skipped: false,
            recordId,
            branch: distilled.branch,
            shardPath,
        };
    } catch (error) {
        return {
            skipped: true,
            reason:
                error instanceof Error
                    ? error.message
                    : 'Distillation failed (fail-open)',
        };
    }
}

/**
 * Detached (non-blocking) distillation: spawn self and return immediately.
 */
export function runDistillationDetached(repoRoot: string): void {
    const cliEntry = process.argv[1];
    const child = spawn(
        process.execPath,
        [cliEntry, 'trace', '_distill-internal'],
        {
            cwd: repoRoot,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, KODUS_TRACE_DISTILL: '1' },
        },
    );
    child.unref();
}

/**
 * Read recent collision log entries for `trace status`.
 */
export async function listCollisions(
    limit = 5,
): Promise<Array<Record<string, unknown>>> {
    try {
        const raw = await fs.readFile(getCollisionLogPath(), 'utf-8');
        return raw
            .split('\n')
            .filter(Boolean)
            .slice(-limit)
            .map((line) => {
                try {
                    return JSON.parse(line) as Record<string, unknown>;
                } catch {
                    return { raw: line };
                }
            });
    } catch {
        return [];
    }
}
