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

/** Marks a note the runtime adds, so the model does not answer it as the developer. */
export const RUNTIME_NOTE_PREFIX =
    '[Kodus runtime status — not a message from the developer. Do not reply to it or record a new decision for it; keep answering the developer.]';

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

        const facts = executed.length
            ? `ACTIONS PERFORMED THIS TURN: ${executed.join(', ')}. Report these and nothing else — do not describe any other action as done.`
            : 'ACTIONS PERFORMED THIS TURN: none. Nothing has changed yet, so do not say you saved, created, recorded or updated anything — you may report an action only once its tool call has returned.';
        // The note arrives as a user turn (the only role a mid-run note can
        // take), and models read it as a new developer message: they recorded
        // a fresh decision for it, step after step, until the step limit
        // (9% of conversations on 26 Nov 2026). Say plainly whose it is.
        const content = `${RUNTIME_NOTE_PREFIX} ${facts}`;

        return { injectNote: { role: 'user', content } };
    }
}
