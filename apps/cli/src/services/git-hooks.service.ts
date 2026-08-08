import fs from 'fs/promises';
import path from 'path';

const KODUS_TRACE_MARKER = '# kodus-trace';
const KODUS_TRACE_END_MARKER = '# /kodus-trace';

// Legacy markers from previous releases — removed on uninstall/enable.
const LEGACY_MARKERS = ['# kodus-session-hooks', '# /kodus-session-hooks'];

const PRE_PUSH_SCRIPT = `
${KODUS_TRACE_MARKER}
# Distill branch decisions onto kodus/trace/v1 (detached, fail-open)
(
  kodus trace _distill-internal --push >/dev/null 2>&1 &
) || true
${KODUS_TRACE_END_MARKER}
`.trimStart();

const PREPARE_COMMIT_MSG_SCRIPT = `
${KODUS_TRACE_MARKER}
# Preserve / append Kodus-Trace trailer across amends when present in env
# (distillation writes the trailer via git commit --amend; this is a no-op
# guard so other tooling does not strip unknown trailers).
true
${KODUS_TRACE_END_MARKER}
`.trimStart();

class GitHooksService {
    /**
     * Install pre-push (detached distill) and a lightweight prepare-commit-msg
     * placeholder. `hooksDir` must be git's real hooks directory.
     */
    async install(
        hooksDir: string,
    ): Promise<{ installed: string[]; alreadyInstalled: string[] }> {
        const installed: string[] = [];
        const alreadyInstalled: string[] = [];

        // Clean legacy markers first
        await this.removeLegacy(hooksDir, 'prepare-commit-msg');
        await this.removeLegacy(hooksDir, 'post-commit');
        await this.removeLegacy(hooksDir, 'pre-push');

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

        const prePushResult = await this.installHook(
            hooksDir,
            'pre-push',
            PRE_PUSH_SCRIPT,
        );
        if (prePushResult.alreadyInstalled) {
            alreadyInstalled.push('pre-push');
        } else {
            installed.push('pre-push');
        }

        return { installed, alreadyInstalled };
    }

    async uninstall(hooksDir: string): Promise<{ removed: string[] }> {
        const removed: string[] = [];

        for (const name of ['prepare-commit-msg', 'post-commit', 'pre-push']) {
            const result = await this.removeHook(hooksDir, name);
            if (result) {
                removed.push(name);
            }
            await this.removeLegacy(hooksDir, name);
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

        if (existing.includes(KODUS_TRACE_MARKER)) {
            return { hookPath, alreadyInstalled: true };
        }

        let content: string;
        if (existing.trim().length === 0) {
            content = `#!/bin/sh\n${script}`;
        } else {
            content = `${existing.replace(/\s*$/, '')}\n\n${script}`;
        }

        await fs.mkdir(path.dirname(hookPath), { recursive: true });
        await fs.writeFile(hookPath, content, { mode: 0o755 });

        return { hookPath, alreadyInstalled: false };
    }

    private async removeHook(
        hooksDir: string,
        hookName: string,
    ): Promise<boolean> {
        return this.removeMarkedBlock(
            hooksDir,
            hookName,
            KODUS_TRACE_MARKER,
            KODUS_TRACE_END_MARKER,
        );
    }

    private async removeLegacy(
        hooksDir: string,
        hookName: string,
    ): Promise<boolean> {
        return this.removeMarkedBlock(
            hooksDir,
            hookName,
            LEGACY_MARKERS[0],
            LEGACY_MARKERS[1],
        );
    }

    private async removeMarkedBlock(
        hooksDir: string,
        hookName: string,
        startMarker: string,
        endMarker: string,
    ): Promise<boolean> {
        const hookPath = path.join(hooksDir, hookName);

        let content: string;
        try {
            content = await fs.readFile(hookPath, 'utf-8');
        } catch {
            return false;
        }

        if (!content.includes(startMarker)) {
            return false;
        }

        const lines = content.split('\n');
        const startIdx = lines.findIndex((line) => line.trim() === startMarker);
        if (startIdx === -1) {
            return false;
        }

        const endIdx = lines.findIndex(
            (line, idx) => idx > startIdx && line.trim() === endMarker,
        );

        const filtered =
            endIdx === -1
                ? lines.slice(0, startIdx)
                : [...lines.slice(0, startIdx), ...lines.slice(endIdx + 1)];

        const remaining = filtered
            .join('\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/\n*$/, '\n');

        if (remaining.trim() === '#!/bin/sh' || remaining.trim() === '') {
            await fs.unlink(hookPath);
        } else {
            await fs.writeFile(hookPath, remaining, { mode: 0o755 });
        }

        return true;
    }
}

export const gitHooksService = new GitHooksService();
