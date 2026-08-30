/**
 * Keeps the model's account of the turn honest by putting the turn's facts in
 * front of it: before each step it is told which write tools have actually run
 * so far. Without this it decides an action is warranted and then reports it as
 * done — on a fresh thread, with nothing executed.
 *
 * Rides the `injectNote` seam, which is kept out of the message window on
 * purpose so the cached prompt prefix survives the injection.
 */
import type {
    AgentPolicy,
    StepDirectives,
    StepView,
} from '@libs/agent-harness/domain/contracts/policy.contract';

export class WriteTruthPolicy implements AgentPolicy {
    readonly name = 'write-truth';

    constructor(private readonly isWriteTool: (name: string) => boolean) {}

    prepareStep(view: StepView): StepDirectives {
        const executed = [
            ...new Set(
                view.steps
                    .flatMap((step) => step.message?.toolCalls ?? [])
                    .filter((call) => !call.isError)
                    .map((call) => call.name)
                    .filter((name) => this.isWriteTool(name)),
            ),
        ];

        const content = executed.length
            ? `ACTIONS PERFORMED THIS TURN: ${executed.join(', ')}. Report these and nothing else — do not describe any other action as done.`
            : 'ACTIONS PERFORMED THIS TURN: none. You have changed nothing. Do not say you saved, created, recorded or updated anything — offer to do it instead, and wait for the developer to confirm.';

        return { injectNote: { role: 'user', content } };
    }
}
