/**
 * Enterprise Code — see `license_ee.md`. Experiment (exp/adversarial-review):
 * two reviewers with different profiles review the same pull request with the
 * same tools, then debate each other's findings for up to five rounds. Only
 * what both endorse at the end leaves the pass.
 *
 * Two variants: an author and an attacker (`attack`), and a correctness and a
 * security reviewer (`focus`). The second reviewer can run on another model
 * (`partner`), so one run can measure two models arguing.
 */
import type {
    AgentRunner,
    AgentSpec,
} from '@libs/agent-harness/domain/contracts/agent.contract';
import type { RunState } from '@libs/agent-harness/domain/contracts/run-state.contract';
import type {
    AgentTool,
    ToolContext,
} from '@libs/agent-harness/domain/contracts/tool.contract';
import {
    type FinderSuggestion,
    type HeavyLensRun,
    FINDER_DONE_TOOL,
    extractFindingsWithRecovery,
    finderLogger,
} from '@libs/code-review/infrastructure/agents/core/finder.agent';
import type { FinderLabel } from '@libs/code-review/infrastructure/agents/engine/finding-labels';
import {
    buildLangfuseTelemetry,
    toAiSdkTelemetryArgs,
} from '@libs/core/log/langfuse';
import { InMemoryToolRegistry } from '@libs/agent-harness/infrastructure/tools/in-memory-tool-registry';

import { type HeavyLens, buildHeavyLensPrompt } from './heavy-lenses';

export const DEBATE_MAX_ROUNDS = 5;
export const DEBATE_MAX_FINDINGS = 8;
/** A debate round checks what is in dispute, it does not review the PR again. */
export const DEBATE_ROUND_STEPS = 6;

export type DebateVariant = 'attack' | 'focus';
export type DebateSide = 'A' | 'B';

export interface DebateProfile {
    side: DebateSide;
    name: string;
    labels: FinderLabel[];
    /** The round-1 assignment, as a lens. */
    lens: HeavyLens;
    /** How this reviewer argues from round 2 on. */
    debateStance: string;
}

export const DEBATE_SYSTEM_PROMPT = `You are one of two code reviewers on the same pull request. Each of you reviews it with your own profile and the same tools, then you debate each other's findings until you agree. Investigate with the tools before deciding, and answer by calling the submitResult tool.`;

const AUTHOR_FOCUS = `- Defects this change introduces: wrong results, crashes, broken contracts with callers or callees, state that goes wrong over time or under concurrency, security holes, and performance regressions. METHOD: read every changed hunk, trace what each change does for the inputs and states callers can actually produce, and read the code around it with the tools before deciding. Report what you can show is wrong.`;

const ATTACKER_FOCUS = `- What a first reviewer of this change is most likely to miss. Act as the adversary of the change: for each changed hunk, write down the input, state, ordering, failure or caller that would break it, then check in the code whether that case can really happen. Look hardest at edge values, empty and missing data, failure and retry paths, concurrent or repeated runs, other callers and other implementations of the same thing, and inputs an attacker controls. Report only the cases you confirmed can happen.`;

const CORRECTNESS_FOCUS = `- Correctness: the change computes or returns the wrong thing, crashes, breaks a contract with its callers or callees, mishandles a failure, or degrades performance. METHOD: for each changed hunk, state what it must do for every input and state callers can produce, then check with the tools that it does. Security is the other reviewer's: do not report it.`;

const SECURITY_FOCUS = `- Security: what an attacker, another tenant or an untrusted input can make this change do. METHOD: for each changed hunk, find what crosses a trust boundary (request data, PR text, file paths, tokens, ids from the client, outputs of other services) and write the input that would bypass a check, read or write another tenant's data, leak a secret, or run something it should not. Check in the code that the path exists. Correctness is the other reviewer's: do not report it unless it is exploitable.`;

const DEFEND = `You defend your own findings with evidence from the code, and withdraw one when the other reviewer's objection holds. Judge the other reviewer's findings honestly: endorse what you can confirm in the code.`;
const ATTACK = `Your job in the debate is to try to refute every finding in the table, yours included: look in the code for the guard, the caller, the type or the configuration that makes it impossible. Endorse only a finding you tried to refute and could not.`;
const CROSS = `Check the other reviewer's findings from your own perspective: endorse the ones you can confirm in the code and object to the rest with the evidence. Defend your own with evidence, and withdraw one when the objection holds.`;

function profile(side: DebateSide, name: string, labels: FinderLabel[], assignment: string, focus: string, debateStance: string, example: string): DebateProfile {
    return {
        side,
        name,
        labels,
        debateStance,
        lens: {
            id: `debate-${name}`,
            label: labels[0] as HeavyLens['label'],
            assignment,
            items: [],
            extraItems: [focus],
            reasoningExample: example,
        },
    };
}

export function debateProfiles(variant: DebateVariant): [DebateProfile, DebateProfile] {
    if (variant === 'attack') {
        return [
            profile('A', 'author', ['bug', 'security', 'performance'], 'find the defects this change introduces', AUTHOR_FOCUS, DEFEND, 'Traced the new retry in sync.ts: the counter is never reset, so the second run gives up at once.'),
            profile('B', 'attacker', ['bug', 'security', 'performance'], 'break this change: find the cases it does not handle', ATTACKER_FOCUS, ATTACK, 'Tried an empty list in parse(): the new index 0 access throws, and the caller in job.ts passes [] when the queue is empty.'),
        ];
    }
    return [
        profile('A', 'correctness', ['bug', 'performance'], 'find the correctness and performance defects this change introduces', CORRECTNESS_FOCUS, CROSS, 'Checked the new pagination in list.ts: the offset is applied after the filter, so page 2 repeats items.'),
        profile('B', 'security', ['security'], 'find what an attacker or another tenant can make this change do', SECURITY_FOCUS, CROSS, 'The new route reads orgId from the body and never compares it with the session, so any user writes another org.'),
    ];
}

/** The done tool with the debate's fields: the ids it endorses, its
 *  objections, and whether it has nothing left to dispute. */
export function withDebateFields(tool: AgentTool): AgentTool {
    const schema = tool.inputSchema as any;
    return {
        ...tool,
        inputSchema: {
            ...schema,
            properties: {
                ...schema.properties,
                keep: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Ids from the table you endorse after this round, yours and the other reviewer\'s.',
                },
                objections: {
                    type: 'array',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: { id: { type: 'string' }, reason: { type: 'string' } },
                        required: ['id', 'reason'],
                    },
                    description: 'Ids you do not endorse, each with the evidence from the code.',
                },
                done: {
                    type: 'boolean',
                    description: 'true when you have nothing left to dispute.',
                },
            },
            required: [...(schema.required ?? []), 'keep', 'objections', 'done'],
        },
    };
}

/** The spec with the debate's done tool in place of the finder's. */
export function debateRoundSpec(spec: AgentSpec, maxSteps: number): AgentSpec {
    const tools = spec.tools.list().map((t) => (t.name === FINDER_DONE_TOOL ? withDebateFields(t) : t));
    return { ...spec, tools: new InMemoryToolRegistry(tools), maxSteps };
}

export interface DebateItem {
    id: string;
    owner: DebateSide;
    finding: FinderSuggestion;
}

export interface DebateTurn {
    keep: string[];
    objections: Array<{ id: string; reason: string }>;
    done: boolean;
    added: FinderSuggestion[];
}

/** The last debate submit of a run, or null when it never submitted one. */
export function debateTurnOf(state: RunState, added: FinderSuggestion[]): DebateTurn | null {
    const artifact = [...state.artifacts].reverse().find((a) => a.type === FINDER_DONE_TOOL);
    const p = artifact?.payload as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return null;
    const keep = Array.isArray(p.keep) ? p.keep.map(String) : [];
    const objections = Array.isArray(p.objections)
        ? (p.objections as any[]).filter((o) => o && o.id).map((o) => ({ id: String(o.id), reason: String(o.reason ?? '') }))
        : [];
    return { keep, objections, done: p.done === true, added };
}

function describe(item: DebateItem, side: DebateSide): string {
    const f = item.finding;
    const whose = item.owner === side ? 'yours' : 'the other reviewer\'s';
    return `[${item.id}] (${whose}) ${f.label ?? 'bug'} — ${f.relevantFile}:${f.relevantLinesStart ?? '?'}-${f.relevantLinesEnd ?? '?'}\n    ${String(f.suggestionContent ?? '').replace(/\s+/g, ' ').trim()}`;
}

export function buildDebateRoundPrompt(args: {
    diffText: string;
    me: DebateProfile;
    round: number;
    items: DebateItem[];
    endorsedBy: Record<DebateSide, Set<string>>;
    objectionsToMe: Array<{ id: string; reason: string }>;
}): string {
    const { me, round, items, endorsedBy } = args;
    const other: DebateSide = me.side === 'A' ? 'B' : 'A';
    const table = items.length
        ? items
              .map((it) => {
                  const marks = [endorsedBy[me.side].has(it.id) ? 'you endorse it' : 'you do not endorse it', endorsedBy[other].has(it.id) ? 'the other reviewer endorses it' : 'the other reviewer does not endorse it'];
                  return `${describe(it, me.side)}\n    (${marks.join('; ')})`;
              })
              .join('\n')
        : '(no findings yet)';
    const objections = args.objectionsToMe.length
        ? args.objectionsToMe.map((o) => `[${o.id}] ${o.reason.replace(/\s+/g, ' ').trim()}`).join('\n')
        : '(none)';
    return `<Diffs>
${args.diffText}
</Diffs>

<Role>
  You are the ${me.name} reviewer of this pull request, in round ${round} of a debate with one other reviewer (at most ${DEBATE_MAX_ROUNDS} rounds). Your assignment: ${me.lens.assignment}.
  ${me.debateStance}
</Role>

<Findings>
${table}
</Findings>

<ObjectionsFromTheOtherReviewer>
${objections}
</ObjectionsFromTheOtherReviewer>

<Task>
  For EVERY finding in the table, decide: endorse it (its id goes in "keep") or object to it (its id goes in "objections", with the evidence from the code). Check in the code with the tools before you decide; never decide from the text alone. For each of your own findings the other reviewer objected to, read the code again: keep it only if the objection is wrong.
  You may add findings the table does not have, in "suggestions", in your own assignment only. Do not repeat a finding already in the table.
  Only findings both reviewers endorse at the end are reported. Set "done" to true when you have nothing left to dispute. The debate stops as soon as both of you are done, or after round ${DEBATE_MAX_ROUNDS}: stop early when you agree.
</Task>

<OutputFormat>
  Call submitResult with:
  - "reasoning": what you checked for each disputed finding, never empty;
  - "suggestions": only NEW findings (an empty list when you add none), each with label, relevantFile, relevantLinesStart, relevantLinesEnd anchored to lines this PR changed, and suggestionContent naming the ONE problem;
  - "keep": the ids you endorse;
  - "objections": [{ "id", "reason" }] for the ids you do not endorse;
  - "done": true or false.
  Never claim something is missing, undefined or not called without first using grep to confirm.
</OutputFormat>`;
}

export interface DebateSideRun {
    profile: DebateProfile;
    runner: AgentRunner;
    spec: AgentSpec;
    modelId: string;
}

export interface DebateResult {
    suggestions: FinderSuggestion[];
    states: RunState[];
    rounds: number;
    stoppedBy: 'both-done' | 'no-change' | 'max-rounds';
}

/**
 * Round 1: both review in parallel. Rounds 2 to 5: both answer the same
 * table in parallel; a side's endorsements become what it kept plus what it
 * added. Stops when both are done, when nothing changed, or after round 5.
 * A side whose round fails keeps its previous endorsements.
 */
export async function runDebate(args: {
    variant: DebateVariant;
    label: string;
    sides: [DebateSideRun, DebateSideRun];
    diffText: string;
    claudeWording: boolean;
    lensBatch?: { index: number; total: number };
    params: Parameters<HeavyLensRun>[0];
    ctx: ToolContext;
}): Promise<DebateResult> {
    const { sides, params, ctx } = args;
    const agentName = params.agentName ?? 'finder';
    const states: RunState[] = [];
    const items: DebateItem[] = [];
    const counters: Record<DebateSide, number> = { A: 0, B: 0 };
    const endorsedBy: Record<DebateSide, Set<string>> = { A: new Set(), B: new Set() };
    let objections: Record<DebateSide, Array<{ id: string; reason: string }>> = { A: [], B: [] };

    const runSide = async (side: DebateSideRun, spec: AgentSpec, prompt: string, round: number) => {
        const state = await side.runner.run(
            spec,
            {
                prompt,
                ...toAiSdkTelemetryArgs(
                    buildLangfuseTelemetry(`${agentName}-debate-${args.variant}-r${round}-${side.profile.side}`, params.telemetryMetadata),
                ),
            },
            ctx,
        );
        states.push(state);
        const extracted = await extractFindingsWithRecovery(state, params.recoverProse, { ...params.telemetryMetadata, modelId: side.modelId });
        const added = (extracted.suggestions ?? [])
            .filter(Boolean)
            .filter((s) => !s.label || side.profile.labels.includes(s.label as FinderLabel))
            .map((s) => ({ ...s, label: (s.label as FinderLabel) ?? side.profile.labels[0] }));
        return { state, added };
    };
    const addItems = (side: DebateSide, found: FinderSuggestion[]) =>
        found.map((finding) => {
            const id = `${side}${++counters[side]}`;
            items.push({ id, owner: side, finding });
            return id;
        });

    const first = await Promise.allSettled(
        sides.map((s) => runSide(s, s.spec, buildHeavyLensPrompt(s.profile.lens, args.diffText, args.claudeWording, false, args.lensBatch), 1)),
    );
    first.forEach((r, i) => {
        const side = sides[i].profile.side;
        if (r.status === 'rejected') {
            finderLogger.warn({ message: `Debate ${args.label} side ${side} failed in round 1`, context: 'finder', error: r.reason, metadata: { organizationId: params.telemetryMetadata?.organizationId, teamId: params.telemetryMetadata?.teamId, pullRequestId: params.telemetryMetadata?.pullRequestId, lens: args.label } });
            return;
        }
        for (const id of addItems(side, r.value.added)) endorsedBy[side].add(id);
    });

    let round = 1;
    let stoppedBy: DebateResult['stoppedBy'] = 'max-rounds';
    while (round < DEBATE_MAX_ROUNDS) {
        if (!items.length) {
            stoppedBy = 'no-change';
            break;
        }
        round++;
        const snapshot = items.slice();
        const before = { A: new Set(endorsedBy.A), B: new Set(endorsedBy.B) };
        const turns = await Promise.allSettled(
            sides.map((s) =>
                runSide(
                    s,
                    debateRoundSpec(s.spec, DEBATE_ROUND_STEPS),
                    buildDebateRoundPrompt({ diffText: args.diffText, me: s.profile, round, items: snapshot, endorsedBy: before, objectionsToMe: objections[s.profile.side] }),
                    round,
                ).then(({ state, added }) => debateTurnOf(state, added)),
            ),
        );
        const next: typeof objections = { A: [], B: [] };
        let bothDone = true;
        let added = 0;
        turns.forEach((r, i) => {
            const side = sides[i].profile.side;
            const other: DebateSide = side === 'A' ? 'B' : 'A';
            const turn = r.status === 'fulfilled' ? r.value : null;
            if (!turn) {
                bothDone = false;
                return;
            }
            const known = new Set(snapshot.map((it) => it.id));
            endorsedBy[side] = new Set(turn.keep.filter((id) => known.has(id)));
            for (const id of addItems(side, turn.added)) endorsedBy[side].add(id);
            added += turn.added.length;
            next[other] = turn.objections.filter((o) => known.has(o.id));
            if (!turn.done) bothDone = false;
        });
        objections = next;
        const unchanged = added === 0 && (['A', 'B'] as const).every((s) => endorsedBy[s].size === before[s].size && [...endorsedBy[s]].every((id) => before[s].has(id)));
        if (bothDone) {
            stoppedBy = 'both-done';
            break;
        }
        if (unchanged) {
            stoppedBy = 'no-change';
            break;
        }
    }

    const agreed = items.filter((it) => endorsedBy.A.has(it.id) && endorsedBy.B.has(it.id)).slice(0, DEBATE_MAX_FINDINGS);
    finderLogger.log({
        message: `Debate ${args.label}: ${items.length} findings raised, ${agreed.length} agreed after ${round} rounds (${stoppedBy})`,
        context: 'finder',
        metadata: { organizationId: params.telemetryMetadata?.organizationId, teamId: params.telemetryMetadata?.teamId, pullRequestId: params.telemetryMetadata?.pullRequestId, lens: args.label, raised: items.length, agreed: agreed.length, rounds: round, stoppedBy },
    });
    return { suggestions: agreed.map((it) => ({ ...it.finding })), states, rounds: round, stoppedBy };
}
