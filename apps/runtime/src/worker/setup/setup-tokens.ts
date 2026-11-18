import type { RuntimeEnvironmentSetupRequested } from '@libs/runtime/api/domain/runtime-commands';

import type { SetupRepoTokensOutcome } from '../agent/http-setup-repo-tokens';
import type { LearnTokensOutcome } from './learn-loop';
import { setupLogger, type SetupRun } from './setup-scope';

// The cell revokes a repository token right after its first download, so a
// setup's boots after the first (a repair, a boot again after expired
// tokens, the learn loop's clean boots) ask the product for new ones. Each
// ask is its own step: a replay reads the same answer.

/** The tokens a fresh answer gives a boot; a member the answer leaves out keeps no token (empty): its claim is refused, naming it. */
export function freshRefs(cmd: RuntimeEnvironmentSetupRequested, fresh: { repoToken: string; workspace?: Array<{ repositoryId: string; sealedRepoToken: string }> }) {
    const members = new Map((fresh.workspace ?? []).map((m) => [m.repositoryId, m.sealedRepoToken]));
    return cmd.workspace?.map((r) => ({ ...r, sealedRepoToken: (r.role === 'primary' ? fresh.repoToken : members.get(r.repositoryId)) ?? '' }));
}

/** New download tokens for `attempt` (`boot`, `repair-<n>`), as the step `name`: a replay reads the same answer. Never throws but on cancellation. */
export function askTokens(run: SetupRun, name: string, attempt: string): Promise<SetupRepoTokensOutcome> {
    const { cmd, cancellationSignal } = run;
    return run.step(name, async (): Promise<SetupRepoTokensOutcome> => {
        cancellationSignal?.()?.throwIfAborted();
        const tokens = run.deps.opts.repoTokens;
        const llmToken = cmd.llmToken;
        if (!tokens) return { status: 'unavailable', message: 'this worker cannot ask the product for new ones' };
        if (!llmToken) return { status: 'unavailable', message: 'the setup carries no token for the product' };
        return tokens
            .refresh({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, attempt })
            .catch((e: Error): SetupRepoTokensOutcome => ({ status: 'unavailable', message: (e?.message ?? String(e)).slice(0, 200) }));
    });
}

/** The next boots download with `fresh`, issued at `issuedAt`. */
export function useTokens(run: SetupRun, fresh: Extract<SetupRepoTokensOutcome, { status: 'issued' }>, issuedAt: string): void {
    run.tokens.sealedRepoToken = fresh.repoToken;
    run.tokens.workspaceRefs = freshRefs(run.cmd, fresh);
    run.tokens.issuedAt = issuedAt;
}

/**
 * New download tokens for the learn loop's k-th clean boot, as a step: a
 * resumed workflow reads the same answer and never asks the product again.
 * The product mints them only for a blocked setup whose loop may boot.
 */
export async function learnTokens(run: SetupRun, k: number): Promise<LearnTokensOutcome> {
    const { cmd, rec } = run;
    const tokens = run.deps.opts.repoTokens;
    const llmToken = cmd.llmToken;
    const fresh = await run.step(`tokens:learn:${k}`, async (): Promise<SetupRepoTokensOutcome> => {
        if (!tokens) return { status: 'unavailable', message: 'this worker cannot ask the product for new ones' };
        if (!llmToken) return { status: 'unavailable', message: 'the setup carries no token for the product' };
        return tokens
            .refresh({ organizationId: cmd.organizationId, llmToken, setupKey: cmd.key, attempt: `learn-${k}` })
            .catch((e: Error): SetupRepoTokensOutcome => ({ status: 'unavailable', message: (e?.message ?? String(e)).slice(0, 200) }));
    });
    if (fresh.status === 'unavailable') {
        setupLogger.warn({ msg: 'setup.learn_tokens_unavailable', environmentId: rec.environmentId, boot: k, error: fresh.message });
        return { status: 'unavailable', message: fresh.message };
    }
    return { status: 'issued', tokens: { repoToken: fresh.repoToken, ...(fresh.workspace ? { workspace: fresh.workspace } : {}) } };
}
