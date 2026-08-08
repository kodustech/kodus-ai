import fs from 'fs/promises';
import path from 'path';

const SESSION_HOOK_MARKER = 'kodus trace hooks codex';
const LEGACY_SESSION_HOOK_MARKER = 'kodus decisions hooks codex';

/**
 * Installs Codex session tracking hooks into ~/.codex/config.toml.
 *
 * Codex uses TOML [[hooks]] arrays:
 *   [[hooks]]
 *   event = "AfterAgent"
 *   command = "kodus trace hooks codex AfterAgent"
 */
export async function installCodexSessionHooks(
    configPath: string,
): Promise<{ configPath: string; changed: boolean }> {
    let content = '';
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            throw error;
        }
    }

    // Replace legacy marker if present
    if (content.includes(LEGACY_SESSION_HOOK_MARKER)) {
        content = content
            .split(LEGACY_SESSION_HOOK_MARKER)
            .join(SESSION_HOOK_MARKER);
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        await fs.writeFile(configPath, content, 'utf-8');
        return { configPath, changed: true };
    }

    if (content.includes(SESSION_HOOK_MARKER)) {
        return { configPath, changed: false };
    }

    const hookBlock = [
        '',
        '[[hooks]]',
        'event = "AfterAgent"',
        `command = "${SESSION_HOOK_MARKER} AfterAgent"`,
        '',
    ].join('\n');

    const nextContent =
        content.trim().length === 0
            ? hookBlock.trim() + '\n'
            : content.replace(/\s*$/, '') + '\n' + hookBlock;

    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, nextContent, 'utf-8');

    return { configPath, changed: true };
}

export async function removeCodexSessionHooks(
    configPath: string,
): Promise<{ configPath: string; removed: boolean }> {
    let content: string;
    try {
        content = await fs.readFile(configPath, 'utf-8');
    } catch {
        return { configPath, removed: false };
    }

    if (
        !content.includes(SESSION_HOOK_MARKER) &&
        !content.includes(LEGACY_SESSION_HOOK_MARKER)
    ) {
        return { configPath, removed: false };
    }

    const lines = content.split('\n');
    const resultLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '[[hooks]]') {
            const blockLines = getTomlBlock(lines, i);
            if (
                blockLines.some(
                    (l) =>
                        l.includes(SESSION_HOOK_MARKER) ||
                        l.includes(LEGACY_SESSION_HOOK_MARKER),
                )
            ) {
                i += blockLines.length;
                continue;
            }
            resultLines.push(...blockLines);
            i += blockLines.length;
            continue;
        }

        resultLines.push(line);
        i += 1;
    }

    const nextContent = resultLines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\n+/, '')
        .replace(/\n*$/, '\n');

    await fs.writeFile(
        configPath,
        nextContent === '\n' ? '' : nextContent,
        'utf-8',
    );

    return { configPath, removed: true };
}

function getTomlBlock(lines: string[], startIdx: number): string[] {
    const block = [lines[startIdx]];
    let i = startIdx + 1;
    while (i < lines.length && !lines[i].trim().startsWith('[[')) {
        block.push(lines[i]);
        i += 1;
    }
    return block;
}
