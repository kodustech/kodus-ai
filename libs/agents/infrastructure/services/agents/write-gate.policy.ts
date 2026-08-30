/**
 * Makes an unasked-for write impossible rather than merely discouraged.
 *
 * The prompt tells the agent to offer first and act only when asked. At low
 * reasoning effort it does not reliably obey: a developer explaining a
 * convention reads to it as permission, and it writes on the spot. Recording is
 * meant to be opt-in, so the first exchange of a thread simply does not carry
 * the write tools — the agent can answer and offer, and nothing more. Once the
 * developer has seen that offer and replied, the tools come back.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '@libs/agent-harness/domain/contracts/policy.contract';

export class WriteGatePolicy implements AgentPolicy {
    readonly name = 'write-gate';

    constructor(
        private readonly isWriteTool: (name: string) => boolean,
        /** Whether this thread already contains a turn the agent answered. */
        private readonly developerHasSeenAnOffer: boolean,
    ) {}

    prepareStep(view: StepView): StepDirectives {
        if (this.developerHasSeenAnOffer) {
            return {};
        }

        return {
            activeTools: view.activeTools.filter(
                (name) => !this.isWriteTool(name),
            ),
            injectNote: {
                role: 'user',
                content:
                    'This is the first exchange of this thread, so you cannot perform any action yet — the tools that change anything are unavailable. Answer, and if something here is worth persisting, offer to do it and wait for a reply.',
            },
            emit: [{ kind: 'write-gate.closed', detail: {} }],
        };
    }
}
