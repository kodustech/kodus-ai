// P14 a convention shown by the code: an agent told to follow the shape the
// existing handlers use cites an existing handler file as the pattern. The
// finding is verified as a bug and posted when the change departs from that
// pattern, and nothing is posted when the change follows it (a control).
// Before #2551 such a finding was dropped as "not a guide linked to this
// review", whatever the change did.
// Invented domain: an irrigation team's valve handlers.

const presentation = {
    tag: { color: '#2563eb' },
    format: 'inline',
    suggestedFix: 'when-confident',
};

const agent = {
    id: 'agent-valve-handlers',
    name: 'Valve handlers',
    enabled: true,
    instructions: [
        'Handlers in src/handlers follow the shape the existing handlers already use.',
        'When a new or changed handler departs from that shape, report it as a convention, citing the existing handler file that shows the pattern and quoting its line.',
        'Do not report naming, formatting or comments.',
    ].join('\n'),
    scope: { include: ['src/handlers/**'] },
    tools: {},
    presentation,
};

const REPO = {
    'src/controller.ts': `export type ValveStatus = 'open' | 'closed' | 'fault';

export declare const controller: {
    open(zone: string): Promise<ValveStatus>;
    close(zone: string): Promise<ValveStatus>;
    drain(zone: string): Promise<ValveStatus>;
};
`,
    'src/handlers/types.ts': `import type { ValveStatus } from '../controller';

/** What every valve handler answers: the zone it acted on and the valve's status. */
export interface ValveResult {
    zone: string;
    status: ValveStatus;
}
`,
    'src/handlers/open-valve.handler.ts': `import { controller } from '../controller';
import type { ValveResult } from './types';

export async function openValve(zone: string): Promise<ValveResult> {
    const status = await controller.open(zone);
    return { zone, status };
}
`,
    'src/handlers/close-valve.handler.ts': `import { controller } from '../controller';
import type { ValveResult } from './types';

export async function closeValve(zone: string): Promise<ValveResult> {
    const status = await controller.close(zone);
    return { zone, status };
}
`,
};

const PATTERN =
    /ValveResult|shape|zone|pattern|open-valve|close-valve|handler/i;

const CODE_PATTERN_CASES = [
    {
        id: 'code-pattern-departed',
        checks: 'An agent that cites an existing handler as the pattern flags a new handler returning a bare status instead of a ValveResult',
        team: { agent },
        prTitle: 'Drain a valve',
        prBody: 'Adds a handler that drains a zone.',
        before: { 'src/handlers/drain-valve.handler.ts': null },
        repo: {
            ...REPO,
            'src/handlers/drain-valve.handler.ts': `import { controller, type ValveStatus } from '../controller';

export async function drainValve(zone: string): Promise<ValveStatus> {
    const status = await controller.drain(zone);
    return status;
}
`,
        },
        expect: [
            {
                property: 'P14',
                flag: 'src/handlers/drain-valve.handler.ts',
                at: 'return status;',
                about: PATTERN,
            },
        ],
    },
    {
        id: 'code-pattern-followed',
        checks: 'The same agent stays quiet on a new handler that answers a ValveResult like the others (control)',
        team: { agent },
        prTitle: 'Drain a valve',
        prBody: 'Adds a handler that drains a zone.',
        before: { 'src/handlers/drain-valve.handler.ts': null },
        repo: {
            ...REPO,
            'src/handlers/drain-valve.handler.ts': `import { controller } from '../controller';
import type { ValveResult } from './types';

export async function drainValve(zone: string): Promise<ValveResult> {
    const status = await controller.drain(zone);
    return { zone, status };
}
`,
        },
        expect: [
            {
                property: 'P14',
                quiet: 'src/handlers/drain-valve.handler.ts',
                about: PATTERN,
            },
        ],
    },
];

module.exports = { CODE_PATTERN_CASES };
