import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { commitSummaryDir, repoStoreDir } from './store-paths.js';
import { listSessions, readSessionRecord } from './session-store.js';
import { saveLocalBranchRecord } from './local-decisions.js';
import {
    pushTraceBranch,
    writeBranchRecord,
} from './decision-branch.service.js';
import { recordIncident } from './incidents.js';
import { redact } from './redaction.js';
import {
    TRACE_DECISION_TYPES,
    type TraceBranchRecord,
    type TraceDecision,
    type TraceDecisionType,
} from '../../types/trace.js';

export interface CommitSummary {
    sha: string;
    subject: string;
    files: string[];
    summary: string;
    points: string[];
}

export type AgentRunner = (prompt: string) => Promise<string>;

export interface DistillOptions {
    branch: string;
    defaultBranch?: string;
    remote?: string;
    runAgent: AgentRunner;
    now?: () => Date;
    push?: boolean;
}

export interface DistillResult {
    record: TraceBranchRecord;
    commitsProcessed: number;
    commitsReused: number;
    pushed: boolean;
    pushRetried: boolean;
    pushError?: string;
}

async function git(gitRoot: string, args: string[]): Promise<string> {
    const result = await execa('git', args, { cwd: gitRoot });
    return result.stdout;
}

async function gitQuiet(
    gitRoot: string,
    args: string[],
): Promise<string | null> {
    try {
        return await git(gitRoot, args);
    } catch {
        return null;
    }
}

export async function resolveDefaultBranch(
    gitRoot: string,
    remote = 'origin',
): Promise<string> {
    const symbolic = await gitQuiet(gitRoot, [
        'symbolic-ref',
        '--short',
        `refs/remotes/${remote}/HEAD`,
    ]);
    if (symbolic) {
        return symbolic.trim();
    }

    for (const candidate of ['main', 'master']) {
        const local = await gitQuiet(gitRoot, [
            'rev-parse',
            '--verify',
            candidate,
        ]);
        if (local) {
            return candidate;
        }
    }

    return 'HEAD';
}

/**
 * Distill one branch.
 *
 * The unit is the branch, not the pull request, because the trigger is
 * `pre-push` — which knows what is being pushed and nothing about PRs. Each run
 * reprocesses the whole `merge-base..HEAD` range and *replaces* the branch's
 * record, so pushing five times leaves one record rather than five
 * mutually-contradictory ones. Per-commit summaries are cached, so a reprocess
 * only pays for commits it has not seen.
 */
export async function distillBranch(
    gitRoot: string,
    options: DistillOptions,
): Promise<DistillResult> {
    const now = options.now ?? (() => new Date());
    const remote = options.remote ?? 'origin';
    const defaultBranch =
        options.defaultBranch ?? (await resolveDefaultBranch(gitRoot, remote));

    const head = (await git(gitRoot, ['rev-parse', 'HEAD'])).trim();
    const mergeBase =
        (
            await gitQuiet(gitRoot, ['merge-base', defaultBranch, 'HEAD'])
        )?.trim() ?? head;

    const range =
        mergeBase === head ? [] : await listCommits(gitRoot, mergeBase, head);

    let commitsProcessed = 0;
    let commitsReused = 0;

    const summaries: CommitSummary[] = [];
    for (const sha of range) {
        const cached = await readCachedSummary(gitRoot, sha);
        if (cached) {
            commitsReused += 1;
            summaries.push(cached);
            continue;
        }

        const summary = await summarizeCommit(gitRoot, sha, options.runAgent);
        await writeCachedSummary(gitRoot, summary);
        commitsProcessed += 1;
        summaries.push(summary);
    }

    const sessions = await collectBranchSessions(gitRoot, options.branch);

    const decisions = await aggregateDecisions({
        branch: options.branch,
        summaries,
        sessions,
        runAgent: options.runAgent,
        createdAt: now().toISOString(),
    });

    const record: TraceBranchRecord = {
        version: 1,
        branch: options.branch,
        mergeBase,
        head,
        commits: range,
        updatedAt: now().toISOString(),
        decisions,
    };

    await saveLocalBranchRecord(gitRoot, record);

    const indexFile = path.join(
        await fs.mkdtemp(path.join(os.tmpdir(), 'kodus-trace-index-')),
        'index',
    );

    try {
        await writeBranchRecord(gitRoot, record, { indexFile });

        if (options.push === false) {
            return {
                record,
                commitsProcessed,
                commitsReused,
                pushed: false,
                pushRetried: false,
            };
        }

        const outcome = await pushTraceBranch(gitRoot, record, {
            remote,
            indexFile,
        });

        if (!outcome.pushed && outcome.error) {
            await recordIncident(gitRoot, {
                at: now().toISOString(),
                kind: 'push-collision',
                branch: options.branch,
                message: outcome.error,
            });
        }

        return {
            record,
            commitsProcessed,
            commitsReused,
            pushed: outcome.pushed,
            pushRetried: outcome.retried,
            pushError: outcome.error,
        };
    } finally {
        await fs
            .rm(path.dirname(indexFile), {
                recursive: true,
                force: true,
            })
            .catch(() => {});
    }
}

async function listCommits(
    gitRoot: string,
    mergeBase: string,
    head: string,
): Promise<string[]> {
    const output = await gitQuiet(gitRoot, [
        'rev-list',
        '--reverse',
        `${mergeBase}..${head}`,
    ]);
    if (!output) {
        return [];
    }
    return output
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Per-commit stage — incremental and cached
// ---------------------------------------------------------------------------

function summaryPath(gitRoot: string, sha: string): string {
    return path.join(commitSummaryDir(gitRoot), `${sha}.json`);
}

export async function readCachedSummary(
    gitRoot: string,
    sha: string,
): Promise<CommitSummary | null> {
    try {
        const raw = await fs.readFile(summaryPath(gitRoot, sha), 'utf-8');
        return JSON.parse(raw) as CommitSummary;
    } catch {
        return null;
    }
}

async function writeCachedSummary(
    gitRoot: string,
    summary: CommitSummary,
): Promise<void> {
    const filePath = summaryPath(gitRoot, summary.sha);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(
        filePath,
        `${JSON.stringify(summary, null, 2)}\n`,
        'utf-8',
    );
}

async function summarizeCommit(
    gitRoot: string,
    sha: string,
    runAgent: AgentRunner,
): Promise<CommitSummary> {
    const subject =
        (await gitQuiet(gitRoot, ['log', '-1', '--format=%s', sha]))?.trim() ??
        '';
    const body =
        (await gitQuiet(gitRoot, ['log', '-1', '--format=%b', sha]))?.trim() ??
        '';
    const filesOutput =
        (await gitQuiet(gitRoot, ['show', '--name-only', '--format=', sha])) ??
        '';

    const files = filesOutput
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    const prompt = [
        'Summarize one commit for a decision log. Reply with JSON only:',
        '{ "summary": "one sentence", "points": ["concrete choice made", ...] }',
        '',
        `Subject: ${redact(subject)}`,
        `Body: ${redact(body)}`,
        `Files: ${files.slice(0, 60).join(', ')}`,
    ].join('\n');

    let summary = '';
    let points: string[] = [];

    try {
        const raw = await runAgent(prompt);
        const parsed = parseJsonObject(raw);
        if (parsed) {
            summary = typeof parsed.summary === 'string' ? parsed.summary : '';
            points = Array.isArray(parsed.points)
                ? parsed.points.filter(
                      (entry): entry is string => typeof entry === 'string',
                  )
                : [];
        }
    } catch {
        // A commit the model choked on still contributes its subject.
    }

    return {
        sha,
        subject,
        files,
        summary: summary || subject,
        points,
    };
}

// ---------------------------------------------------------------------------
// Per-branch stage — dedupe, resolve contradictions, type each survivor
// ---------------------------------------------------------------------------

interface BranchSessionInput {
    sessionId: string;
    turns: Array<{
        prompt: string;
        response: string;
        filesModified: string[];
    }>;
    filesTouched: string[];
}

async function collectBranchSessions(
    gitRoot: string,
    branch: string,
): Promise<BranchSessionInput[]> {
    const summaries = await listSessions(gitRoot);
    const relevant = summaries.filter((entry) => entry.branch === branch);

    const sessions = await Promise.all(
        relevant.slice(0, 40).map(async (entry) => {
            const session = await readSessionRecord(gitRoot, entry.sessionId);
            if (!session) {
                return null;
            }
            return {
                sessionId: session.sessionId,
                turns: session.turns.slice(0, 30).map((turn) => ({
                    prompt: turn.prompt.slice(0, 4000),
                    response: turn.response.slice(0, 4000),
                    filesModified: turn.filesModified.map(
                        (change) => change.path,
                    ),
                })),
                filesTouched: entry.filesTouched,
            } satisfies BranchSessionInput;
        }),
    );

    return sessions.filter(
        (entry): entry is BranchSessionInput => entry !== null,
    );
}

interface AggregateInput {
    branch: string;
    summaries: CommitSummary[];
    sessions: BranchSessionInput[];
    runAgent: AgentRunner;
    createdAt: string;
}

async function aggregateDecisions(
    input: AggregateInput,
): Promise<TraceDecision[]> {
    const scopeCandidates = [
        ...new Set([
            ...input.summaries.flatMap((entry) => entry.files),
            ...input.sessions.flatMap((entry) => entry.filesTouched),
        ]),
    ];

    const prompt = buildAggregatePrompt(input, scopeCandidates);

    let raw: string;
    try {
        raw = await input.runAgent(prompt);
    } catch {
        return [];
    }

    const parsed = parseJsonObject(raw);
    const rawDecisions = Array.isArray(parsed?.decisions)
        ? parsed.decisions
        : [];

    const seen = new Set<string>();
    const decisions: TraceDecision[] = [];

    for (const entry of rawDecisions) {
        const decision = normalizeDecision(
            entry,
            input.branch,
            scopeCandidates,
            input.createdAt,
            input.summaries.map((summary) => summary.sha),
            input.sessions.map((session) => session.sessionId),
        );
        if (!decision || seen.has(decision.id)) {
            continue;
        }
        seen.add(decision.id);
        decisions.push(decision);
    }

    return decisions;
}

function buildAggregatePrompt(
    input: AggregateInput,
    scopeCandidates: string[],
): string {
    const payload = {
        branch: input.branch,
        commits: input.summaries.map((summary) => ({
            sha: summary.sha.slice(0, 12),
            subject: redact(summary.subject),
            summary: redact(summary.summary),
            points: summary.points.map((point) => redact(point)),
            files: summary.files.slice(0, 40),
        })),
        sessions: input.sessions.map((session) => ({
            turns: session.turns.map((turn) => ({
                prompt: redact(turn.prompt),
                response: redact(turn.response),
                filesModified: turn.filesModified.slice(0, 20),
            })),
        })),
        knownFiles: scopeCandidates.slice(0, 200),
    };

    return [
        'You are distilling one branch of work into reusable decisions.',
        'Deduplicate across commits and resolve contradictions: when a later',
        'commit reverses an earlier choice, keep only the final one.',
        '',
        'Reply with JSON only, no prose:',
        '{ "decisions": [ {',
        '  "type": "architectural_decision|convention|tradeoff|implementation_detail|tooling|other",',
        '  "origin": "human|agent|collaborative",',
        '  "decision": "one concrete choice, self-contained",',
        '  "rationale": "why",',
        '  "confidence": 0.0,',
        '  "evidence": ["..."],',
        '  "scope": ["path/from/knownFiles.ts"]',
        '} ] }',
        '',
        'Rules:',
        '- "scope" must contain paths drawn from knownFiles (a directory prefix is fine).',
        '- Extract concrete choices, not generic statements.',
        '- If nothing useful exists, return { "decisions": [] }.',
        '',
        JSON.stringify(payload),
    ].join('\n');
}

function normalizeDecision(
    raw: unknown,
    branch: string,
    scopeCandidates: string[],
    createdAt: string,
    commits: string[],
    sessionIds: string[],
): TraceDecision | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const entry = raw as Record<string, unknown>;
    const text =
        typeof entry.decision === 'string' ? entry.decision.trim() : '';
    if (!text) {
        return null;
    }

    const scope = normalizeScope(entry.scope, scopeCandidates);
    const type = normalizeType(entry.type);
    const confidence = normalizeConfidence(entry.confidence);

    return {
        id: decisionId(branch, text, scope),
        type,
        origin: normalizeOrigin(entry.origin),
        decision: redact(text).slice(0, 500),
        rationale:
            typeof entry.rationale === 'string'
                ? redact(entry.rationale).slice(0, 1000)
                : undefined,
        confidence,
        evidence: Array.isArray(entry.evidence)
            ? entry.evidence
                  .filter((item): item is string => typeof item === 'string')
                  .map((item) => redact(item).slice(0, 300))
                  .slice(0, 5)
            : undefined,
        scope,
        autoPromoteCandidate:
            typeof confidence === 'number' &&
            confidence >= 0.7 &&
            ['architectural_decision', 'convention', 'tradeoff'].includes(type),
        branch,
        commits: commits.slice(0, 50),
        sessionIds: sessionIds.slice(0, 50),
        createdAt,
    };
}

/**
 * Stable across re-distillation so that a `pin` or `forget` from three pushes
 * ago still lands on the same decision.
 */
export function decisionId(
    branch: string,
    text: string,
    scope: string[],
): string {
    return crypto
        .createHash('sha256')
        .update(`${branch} ${text} ${[...scope].sort().join(',')}`)
        .digest('hex')
        .slice(0, 16);
}

function normalizeScope(raw: unknown, candidates: string[]): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const normalized = raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
        .filter(Boolean);

    // Keep model-invented paths out of the store: a scope entry only counts if
    // it is, or prefixes, a path the branch actually touched.
    const valid = normalized.filter((entry) =>
        candidates.some(
            (candidate) =>
                candidate === entry || candidate.startsWith(`${entry}/`),
        ),
    );

    return [...new Set(valid)].slice(0, 20);
}

function normalizeType(raw: unknown): TraceDecisionType {
    return TRACE_DECISION_TYPES.includes(raw as TraceDecisionType)
        ? (raw as TraceDecisionType)
        : 'other';
}

function normalizeOrigin(raw: unknown): TraceDecision['origin'] | undefined {
    return raw === 'human' || raw === 'agent' || raw === 'collaborative'
        ? raw
        : undefined;
}

function normalizeConfidence(raw: unknown): number | undefined {
    if (typeof raw !== 'number' || Number.isNaN(raw)) {
        return undefined;
    }
    return Math.max(0, Math.min(1, raw));
}

/**
 * Agent CLIs wrap their answer in prose no matter how firmly you ask them not
 * to, so pull the first balanced JSON object out of the output.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }

    const direct = tryParse(trimmed);
    if (direct) {
        return direct;
    }

    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        const parsed = tryParse(fenced[1].trim());
        if (parsed) {
            return parsed;
        }
    }

    const start = trimmed.indexOf('{');
    if (start === -1) {
        return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let index = start; index < trimmed.length; index++) {
        const char = trimmed[index];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) {
            continue;
        }
        if (char === '{') {
            depth += 1;
        } else if (char === '}') {
            depth -= 1;
            if (depth === 0) {
                return tryParse(trimmed.slice(start, index + 1));
            }
        }
    }

    return null;
}

function tryParse(value: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
}

export function distillStoreDir(gitRoot: string): string {
    return repoStoreDir(gitRoot);
}
