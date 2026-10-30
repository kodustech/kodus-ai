/**
 * #2172 — custom agents keep to their lane, and the custom agents of one
 * review share a system-prompt prefix the provider can cache.
 */
import {
    buildSystemPrompt,
    buildUserPrompt,
    hasOwnLane,
    type PromptAgentMeta,
} from '@libs/code-review/infrastructure/agents/prompts/prompt-builder';
import { CACHE_PREFIX_BOUNDARY } from '@libs/llm/prompt-cache-boundary';

const generalist: PromptAgentMeta = {
    identity: {
        name: 'kodus-generalist-review-agent',
        description: 'finds bugs, security and performance issues',
        goal: 'g',
        expertise: ['x'],
    },
    categoryPrompt: '<Category>generalist</Category>',
    categoryLabel: 'generalist',
    allowedLabels: ['bug', 'security', 'performance'],
    supportsMixed: true,
    knowledgeSection: '<TeamKnowledge>skills</TeamKnowledge>',
};

const input = (over: any = {}): any => ({
    remoteCommands: {},
    changedFiles: [
        {
            filename: 'src/pagination.ts',
            patch: '@@ -1 +1,2 @@\n+const x = 1;',
        },
    ],
    languageResultPrompt: 'pt-BR',
    prTitle: 't',
    prBody: 'b',
    memoryRules: [{ title: 'r', rule: 'do x' }],
    commits: [{ sha: 'abcdef123456', message: 'feat: x', date: '2026-01-01' }],
    linkedRepoAccess: {
        list: () => [{ repository: 'o/r', preferredRef: 'main' }],
    },
    ...over,
});

const customAgent = (
    name: string,
    instructions: string,
    over: Partial<PromptAgentMeta> = {},
): PromptAgentMeta => ({
    identity: {
        name: `kodus-custom-agent-${name.toLowerCase().replace(/\W+/g, '-')}`,
        description: `Team-defined reviewer "${name}".`,
        goal: 'g',
        expertise: [name],
    },
    categoryPrompt: `  <Mission>You are the team's "${name}" reviewer.</Mission>\n  <TeamInstructions>\n${instructions}\n  </TeamInstructions>`,
    categoryLabel: 'custom_agent',
    allowedLabels: ['bug'],
    supportsMixed: false,
    conventionGuides: [],
    ...over,
});

const e2e = customAgent(
    'Booking E2E',
    'Every new booking screen needs an end-to-end test under e2e/bookings.',
);
const security = customAgent(
    'Booking Security',
    'Flag booking endpoints that skip the tenant check.',
    {
        conventionGuides: ['.skills/tenancy/SKILL.md'],
        knowledgeSection: '<TeamKnowledge>tenancy skill</TeamKnowledge>',
    },
);

const commonPrefixLength = (a: string, b: string) => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
};

beforeAll(() => {
    jest.useFakeTimers({ doNotFake: ['performance'] });
    jest.setSystemTime(new Date('2026-01-15T12:00:00Z'));
});

afterAll(() => {
    jest.useRealTimers();
});

describe('generalist prompt', () => {
    it('carries no shared-prefix marker', () => {
        expect(buildSystemPrompt(input(), generalist)).not.toContain(
            CACHE_PREFIX_BOUNDARY,
        );
        expect(hasOwnLane(generalist)).toBe(false);
    });
});

describe('custom agent — lane focus', () => {
    it('replaces the defect hunt with a hunt scoped to its focus', () => {
        const system = buildSystemPrompt(input(), e2e);

        expect(hasOwnLane(e2e)).toBe(true);
        expect(system).toContain(
            'The generalist reviewer already covers general correctness bugs on it.',
        );
        expect(system).toContain('Report only findings within your focus');
        expect(system).toContain(
            'Do not trace call chains or hunt for defects your focus does not cover.',
        );
        expect(system).not.toContain(
            'Assume every change is broken until you prove it is safe.',
        );
        expect(system).not.toContain('High-recall mode');
        // The evidence discipline stays.
        expect(system).toContain('IMPORTANT — VERIFY BEFORE CLAIMING:');
        expect(system).toContain('give a one-line certificate');
        expect(system).toContain(
            'Root cause must be in lines added or modified by this PR.',
        );
        expect(system).toContain(
            'Every new booking screen needs an end-to-end test',
        );
    });

    it('scopes the task and the reporting rules of its user prompt', () => {
        const user = buildUserPrompt(input(), e2e);

        expect(user).toContain(
            'Review this Pull Request for the issues your focus covers',
        );
        expect(user).toContain('Report only findings within your focus.');
        expect(user).not.toContain('Reporting threshold (high-recall)');
        expect(user).not.toContain(
            'Missing defensive measures (CSRF, rate limiting, input validation)',
        );
        expect(user).toContain('<Diffs>');
        expect(user).toContain('Assign a confidence score (1-10)');
    });

    it('scopes the compact prompt too, and keeps its instructions there', () => {
        const compact = input({ adaptiveProfile: { compactPrompt: true } });
        const system = buildSystemPrompt(compact, e2e);

        expect(system).toContain('Report only findings within your focus');
        expect(system).toContain(
            'Every new booking screen needs an end-to-end test',
        );
        expect(system).not.toContain('Default to reporting');
        expect(buildUserPrompt(compact, e2e)).not.toContain(
            'Reporting threshold (high-recall)',
        );
    });
});

describe('custom agent — no sandbox', () => {
    // A review with no sandbox runs every agent without the repository. The
    // agent keeps its own lane there instead of the generalist's checklist.
    const noSandbox = input({ remoteCommands: undefined });

    it('keeps its lane and its instructions in the system prompt', () => {
        const system = buildSystemPrompt(noSandbox, e2e);

        expect(system).toContain('<CodeReviewAgent mode="self-contained">');
        expect(system).toContain('Report only findings within your focus');
        expect(system).toContain(
            'Every new booking screen needs an end-to-end test',
        );
        expect(system).toContain('cannot read the repository');
        // Its team systems and guides do not need the sandbox: the prompt
        // must not forbid evidence from them.
        expect(system).toContain("the team's systems and your guides");
        expect(system).not.toContain('available only where');
        expect(system).not.toContain('Your first action must be a tool call');
        expect(system).not.toContain(
            'Is there a null/undefined dereference on a path the diff introduces?',
        );
    });

    it('scopes the task and the reporting rules of its user prompt', () => {
        const user = buildUserPrompt(noSandbox, e2e);

        expect(user).toContain('<ReviewTask mode="self-contained">');
        expect(user).toContain('the issues your focus covers');
        expect(user).toContain('Report only findings within your focus.');
        expect(user).not.toContain(
            'DO report: null/undefined dereferences with no guard',
        );
        expect(user).toContain('<Diffs>');
        expect(user).toContain('Assign a confidence score (1-10)');
    });
});

describe('custom agent — conflicting sources', () => {
    const CONFLICT = 'When two sources give conflicting rules for this code';

    it('asks an agent with guides to name the disagreement, not pick silently', () => {
        for (const given of [
            input(),
            input({ adaptiveProfile: { compactPrompt: true } }),
        ]) {
            const system = buildSystemPrompt(given, security);
            expect(system).toContain(CONFLICT);
            expect(system).toContain('never apply one silently');
            expect(system).toContain('report the conflict itself');
        }
    });

    it('stays out of the prompts of an agent without guides and of the generalist', () => {
        expect(buildSystemPrompt(input(), e2e)).not.toContain(CONFLICT);
        expect(buildSystemPrompt(input(), generalist)).not.toContain(CONFLICT);
    });
});

describe('custom agent — shared system-prompt prefix', () => {
    it('two custom agents share everything up to their Role', () => {
        const a = buildSystemPrompt(input(), e2e);
        const b = buildSystemPrompt(input(), security);
        const boundaryEnd =
            a.indexOf(CACHE_PREFIX_BOUNDARY) + CACHE_PREFIX_BOUNDARY.length;

        expect(a.indexOf(CACHE_PREFIX_BOUNDARY)).toBe(
            b.indexOf(CACHE_PREFIX_BOUNDARY),
        );
        // The prefix is the whole static block: date, mindset, workflow, scope.
        expect(commonPrefixLength(a, b)).toBeGreaterThanOrEqual(boundaryEnd);
        expect(boundaryEnd).toBeGreaterThan(4000);
        const prefix = a.slice(0, boundaryEnd);
        expect(prefix).toContain('<Date>15/01/2026</Date>');
        expect(prefix).toContain('</Workflow>');
        expect(prefix).toContain('</Scope>');
        // Nothing that names the agent is in it.
        expect(prefix).not.toContain('Booking');
        expect(prefix).not.toContain('kodus-custom-agent');
        expect(prefix).not.toContain('  <Role>\n');
        // What names the agent comes right after.
        expect(a.slice(boundaryEnd)).toMatch(
            /^\n {2}<Role>\n {4}You are kodus-custom-agent-booking-e2e/,
        );
        expect(b).toContain('tenancy skill');
    });

    it('the compact prompts share their prefix too', () => {
        const compact = input({ adaptiveProfile: { compactPrompt: true } });
        const a = buildSystemPrompt(compact, e2e);
        const b = buildSystemPrompt(compact, security);
        const boundaryEnd =
            a.indexOf(CACHE_PREFIX_BOUNDARY) + CACHE_PREFIX_BOUNDARY.length;

        expect(boundaryEnd).toBeGreaterThan(CACHE_PREFIX_BOUNDARY.length);
        expect(commonPrefixLength(a, b)).toBeGreaterThanOrEqual(boundaryEnd);
    });
});
