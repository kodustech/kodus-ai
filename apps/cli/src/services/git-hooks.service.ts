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
# Git writes one line per ref to stdin:
#   <local-ref> <local-sha> <remote-ref> <remote-sha>
# Records use the destination branch name because that is the stable shared
# name another clone fetches. The exact object ids come from Git's stdin; the
# hook never consults the currently checked-out branch or HEAD.
if [ -z "$KODUS_TRACE_SKIP" ] && command -v kodus >/dev/null 2>&1; then
  while read -r KODUS_LOCAL_REF KODUS_LOCAL_SHA KODUS_REMOTE_REF KODUS_REMOTE_SHA; do
    case "$KODUS_REMOTE_REF" in
      refs/heads/kodus/trace/v1) continue ;;
      refs/heads/*) ;;
      *) continue ;;
    esac

    # A deletion has an all-zero local object id (SHA-1 or SHA-256).
    case "$KODUS_LOCAL_SHA" in
      ''|*[!0]*) ;;
      *) continue ;;
    esac

    KODUS_TRACE_BRANCH="\${KODUS_REMOTE_REF#refs/heads/}"
    kodus trace distill \\
      --branch "$KODUS_TRACE_BRANCH" \\
      --head "$KODUS_LOCAL_SHA" \\
      --remote "$1" \\
      >/dev/null 2>&1 </dev/null &
  done
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

        // Releases before Trace used post-commit. Nothing is installed there
        // now, but upgrade must remove the dead block proactively.
        await this.removeLegacyHook(hooksDir, 'post-commit');

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

        // Replace every previous/current block with the exact current script.
        // This is both the upgrade path and what makes enable byte-idempotent.
        const withoutLegacy = stripBlocks(
            existing,
            LEGACY_MARKERS,
            LEGACY_END_MARKERS,
        );
        const currentBlocks = extractBlocks(
            existing,
            TRACE_HOOK_MARKER,
            TRACE_HOOK_END_MARKER,
        );
        if (
            withoutLegacy === existing &&
            currentBlocks.length === 1 &&
            currentBlocks[0].trimEnd() === script.trimEnd()
        ) {
            return { hookPath, alreadyInstalled: true };
        }
        const withoutTrace = stripBlocks(
            withoutLegacy,
            [TRACE_HOOK_MARKER],
            [TRACE_HOOK_END_MARKER],
        );
        const content = appendHookBlock(withoutTrace, script);

        if (content === existing) {
            return { hookPath, alreadyInstalled: true };
        }

        await fs.mkdir(path.dirname(hookPath), { recursive: true });
        await fs.writeFile(hookPath, content, { mode: 0o755 });

        return { hookPath, alreadyInstalled: false };
    }

    private async removeLegacyHook(
        hooksDir: string,
        hookName: string,
    ): Promise<void> {
        const hookPath = path.join(hooksDir, hookName);
        let content: string;
        try {
            content = await fs.readFile(hookPath, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return;
            }
            throw error;
        }
        const remaining = stripBlocks(
            content,
            LEGACY_MARKERS,
            LEGACY_END_MARKERS,
        );
        if (remaining === content) {
            return;
        }
        if (remaining.trim() === '#!/bin/sh' || remaining.trim() === '') {
            await fs.unlink(hookPath);
        } else {
            await fs.writeFile(hookPath, remaining, { mode: 0o755 });
        }
    }

    private async removeHook(
        hooksDir: string,
        hookName: string,
    ): Promise<boolean> {
        const hookPath = path.join(hooksDir, hookName);

        let content: string;
        try {
            content = await fs.readFile(hookPath, 'utf-8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
                return false;
            }
            throw error;
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
    if (!lines.some((line) => markers.includes(line.trim()))) {
        return content;
    }

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

        if (endIdx === -1) {
            // A truncated/corrupt block has no trustworthy boundary. Remove
            // only recognizable Kodus lines and preserve user content after
            // the marker instead of deleting the rest of the file.
            lines = lines.filter(
                (line, idx) =>
                    idx !== startIdx &&
                    !(
                        idx > startIdx &&
                        /(?:kodus (?:trace|sessions|decisions)|Kodus-Trace|Kody-Checkpoint|KODUS_TRACE_)/i.test(
                            line,
                        )
                    ),
            );
        } else {
            lines = [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];
        }
    }

    return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\n*$/, '\n');
}

function appendHookBlock(existing: string, script: string): string {
    const base = existing.replace(/\s*$/, '');
    return base.trim().length === 0
        ? `#!/bin/sh\n${script}`
        : `${base}\n\n${script}`;
}

function extractBlocks(
    content: string,
    marker: string,
    endMarker: string,
): string[] {
    const lines = content.split('\n');
    const blocks: string[] = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (lines[index].trim() !== marker) {
            continue;
        }
        const end = lines.findIndex(
            (line, candidate) => candidate > index && line.trim() === endMarker,
        );
        if (end === -1) {
            continue;
        }
        blocks.push(lines.slice(index, end + 1).join('\n'));
        index = end;
    }
    return blocks;
}

export const gitHooksService = new GitHooksService();
export { PREPARE_COMMIT_MSG_SCRIPT, PRE_PUSH_SCRIPT };
