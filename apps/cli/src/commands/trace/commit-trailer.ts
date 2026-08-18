import { gitService } from '../../services/git.service.js';
import { listSessions } from '../../services/trace/session-store.js';

export const TRACE_TRAILER_KEY = 'Kodus-Trace';

/**
 * Prints `Kodus-Trace: <id>` for the session that produced the work being
 * committed, or nothing at all.
 *
 * Called by the prepare-commit-msg hook. Silence is a valid answer — a commit
 * made outside an agent session gets no trailer.
 */
export async function commitTrailerAction(): Promise<void> {
    const trailer = await resolveCommitTrailer();
    if (trailer) {
        process.stdout.write(`${trailer}\n`);
    }
}

export async function resolveCommitTrailer(): Promise<string | null> {
    try {
        const isRepo = await gitService.isGitRepository();
        if (!isRepo) {
            return null;
        }

        const gitRoot = (await gitService.getGitRoot()).trim();
        const branch = await gitService
            .getCurrentBranch()
            .then((value) => value.trim())
            .catch(() => '');

        const sessions = await listSessions(gitRoot);
        if (sessions.length === 0) {
            return null;
        }

        // listSessions is newest-first. A named branch may only link to a
        // session captured on that same branch. Detached HEAD has no branch
        // identity, so only there do we use the newest captured session.
        const match = branch
            ? sessions.find((entry) => entry.branch === branch)
            : sessions[0];

        if (!match) {
            return null;
        }

        const id = match.sessionId.slice(0, 12);
        return id ? `${TRACE_TRAILER_KEY}: ${id}` : null;
    } catch {
        // A commit must never fail because of this.
        return null;
    }
}
