import fs from 'fs/promises';
import path from 'path';

export const TRACE_HOOK_MARKER = '# kodus-trace';
export const TRACE_HOOK_END_MARKER = '# /kodus-trace';

/** Hook blocks written by the release this work replaces. */
const LEGACY_MARKERS = ['# kodus-session-hooks'];
const LEGACY_END_MARKERS = ['# /kodus-session-hooks'];

/**
 * Commit linkage uses a trailer rather than git notes: notes are not pushed or
 * fetched without extra refspec configuration and are orphaned by rebase, while
 * a trailer is part of the message and is therefore rewritten with it.
 */
const PREPARE_COMMIT_MSG_SCRIPT = `
${TRACE_HOOK_MARKER}
# Add the Kodus-Trace trailer linking this commit to its captured session.
if command -v kodus >/dev/null 2>&1; then
  if ! grep -q '^Kodus-Trace:' "$1" 2>/dev/null; then
    KODUS_TRACE_TRAILER="$(kodus trace commit-trailer 2>/dev/null)"
    if [ -n "$KODUS_TRACE_TRAILER" ]; then
      printf '\\n%s\\n' "$KODUS_TRACE_TRAILER" >> "$1"
    fi
  fi
fi
${TRACE_HOOK_END_MARKER}
`.trimStart();

/**
 * Distillation runs here, not in the commit hook, so `git commit` stays fast —
 * and it is detached so `git push` never waits on a model.
 */
const PRE_PUSH_SCRIPT = `
${TRACE_HOOK_MARKER}
# Distill the pushed branch into decisions. Detached: the push does not wait.
if [ -z "$KODUS_TRACE_SKIP" ] && command -v kodus >/dev/null 2>&1; then
  KODUS_TRACE_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null)"
  if [ -n "$KODUS_TRACE_BRANCH" ]; then
    (kodus trace distill --branch "$KODUS_TRACE_BRANCH" >/dev/null 2>&1 &) </dev/null
  fi
fi
${TRACE_HOOK_END_MARKER}
`.trimStart();

class GitHooksService {
    /**
     * Install the prepare-commit-msg (trailer) and pre-push (distillation)
     * hooks.
     *
     * `hooksDir` must be the directory git actually executes hooks from —
     * resolve it with `gitService.getHooksDir()` rather than joining
     * `.git/hooks` onto the worktree root, which breaks inside linked
     * worktrees (where `.git` is a file) and ignores `core.hooksPath`.
     */
    async install(
        hooksDir: string,
    ): Promise<{ installed: string[]; alreadyInstalled: string[] }> {
        const installed: string[] = [];
        const alreadyInstalled: string[] = [];

        const prepareResult = await this.installHook(
            hooksDir,
            'prepare-commit-msg',
            PREPARE_COMMIT_MSG_SCRIPT,
        );
        if (prepareResult.alreadyInstalled) {
            alreadyInstalled.push('prepare-commit-msg');
        } else {
            installed.push('prepare-commit-msg');
        }

        const pushResult = await this.installHook(
            hooksDir,
            'pre-push',
            PRE_PUSH_SCRIPT,
        );
        if (pushResult.alreadyInstalled) {
            alreadyInstalled.push('pre-push');
        } else {
            installed.push('pre-push');
        }

        return { installed, alreadyInstalled };
    }

    /** Remove kodus trace blocks (and any left by the previous release). */
    async uninstall(hooksDir: string): Promise<{ removed: string[] }> {
        const removed: string[] = [];

        for (const hookName of [
            'prepare-commit-msg',
            'pre-push',
            'post-commit',
        ]) {
            if (await this.removeHook(hooksDir, hookName)) {
                removed.push(hookName);
            }
        }

        return { removed };
    }

    private async installHook(
        hooksDir: string,
        hookName: string,
        script: string,
    ): Promise<{ hookPath: string; alreadyInstalled: boolean }> {
        const hookPath = path.join(hooksDir, hookName);

        let existing = '';
        try {
            existing = await fs.readFile(hookPath, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                throw error;
            }
        }

        // A hook from the previous release has to go before ours lands, or the
        // file ends up running both.
        existing = stripBlocks(existing, LEGACY_MARKERS, LEGACY_END_MARKERS);

        if (existing.includes(TRACE_HOOK_MARKER)) {
            return { hookPath, alreadyInstalled: true };
        }

        const content =
            existing.trim().length === 0
                ? `#!/bin/sh\n${script}`
                : `${existing.replace(/\s*$/, '')}\n\n${script}`;

        await fs.mkdir(path.dirname(hookPath), { recursive: true });
        await fs.writeFile(hookPath, content, { mode: 0o755 });

        return { hookPath, alreadyInstalled: false };
    }

    private async removeHook(
        hooksDir: string,
        hookName: string,
    ): Promise<boolean> {
        const hookPath = path.join(hooksDir, hookName);

        let content: string;
        try {
            content = await fs.readFile(hookPath, 'utf-8');
        } catch {
            return false;
        }

        const markers = [TRACE_HOOK_MARKER, ...LEGACY_MARKERS];
        if (!markers.some((marker) => content.includes(marker))) {
            return false;
        }

        const remaining = stripBlocks(content, markers, [
            TRACE_HOOK_END_MARKER,
            ...LEGACY_END_MARKERS,
        ]);

        if (remaining.trim() === '#!/bin/sh' || remaining.trim() === '') {
            await fs.unlink(hookPath);
        } else {
            await fs.writeFile(hookPath, remaining, { mode: 0o755 });
        }

        return true;
    }
}

/**
 * Remove every `<marker> … <endMarker>` block from a hook script, leaving any
 * hand-written content around it intact.
 */
export function stripBlocks(
    content: string,
    markers: string[],
    endMarkers: string[],
): string {
    if (!content) {
        return content;
    }

    let lines = content.split('\n');

    // A hook file can hold more than one of our blocks (an upgrade path that
    // appended twice, say), so keep going until none are left.
    for (;;) {
        const startIdx = lines.findIndex((line) =>
            markers.includes(line.trim()),
        );
        if (startIdx === -1) {
            break;
        }

        const endIdx = lines.findIndex(
            (line, idx) => idx > startIdx && endMarkers.includes(line.trim()),
        );

        lines =
            endIdx === -1
                ? lines.slice(0, startIdx)
                : [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
    }

    return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n*$/, '\n');
}

export const gitHooksService = new GitHooksService();
export { PREPARE_COMMIT_MSG_SCRIPT, PRE_PUSH_SCRIPT };
