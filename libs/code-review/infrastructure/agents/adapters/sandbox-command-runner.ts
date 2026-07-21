/**
 * code-review (domain) — adapts the sandbox's RemoteCommands.exec to the
 * agent-harness CommandRunner port, so ExecutableVerifier can run `tsc`/lint in
 * the cloned repo. The harness stays tenant-agnostic; this is the one place
 * that knows the sandbox exists.
 *
 * A sandbox without `exec` (or an exec that rejects) surfaces as a
 * NON-LAUNCHABLE command — the ExecutableVerifier then fails open (keeps the
 * finding), which is exactly what we want: no objective signal must never mean
 * a silent drop.
 */
import type {
    CommandRunner,
    CommandResult,
} from '@libs/agent-harness/domain/contracts/command-runner.contract';
import type { RemoteCommands } from '@libs/code-review/infrastructure/adapters/services/collectCrossFileContexts.service';

export class SandboxCommandRunner implements CommandRunner {
    constructor(private readonly remote: RemoteCommands) {}

    async run(command: string): Promise<CommandResult> {
        if (!this.remote.exec) {
            // No exec capability → treat as "could not launch" so the verifier
            // fails open. (RemoteCommands.exec has no cancellation hook, so the
            // CommandRunner signal is intentionally not forwarded here.)
            throw new Error('sandbox has no exec capability');
        }
        return this.remote.exec(command);
    }
}
