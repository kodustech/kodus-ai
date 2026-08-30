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
            : 'ACTIONS PERFORMED THIS TURN: none. Nothing has changed yet, so do not say you saved, created, recorded or updated anything. If the developer just asked you to act, call the tool now — you may report it only once the call has returned.';

        return { injectNote: { role: 'user', content } };
    }
}
