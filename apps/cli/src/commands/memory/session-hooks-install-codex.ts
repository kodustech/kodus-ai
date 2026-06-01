import fs from 'fs/promises';
import path from 'path';

const SESSION_HOOK_MARKER = 'kodus decisions hooks codex';

/**
 * Installs Codex session tracking hooks into ~/.codex/config.toml.
 *
 * Codex uses TOML [[hooks]] arrays:
 *   [[hooks]]
 *   event = "AfterAgent"
 *   command = "kodus decisions hooks codex AfterAgent"
 *
 * Currently only AfterAgent is useful (maps to TurnEnd).
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

    // Check if already installed
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

    if (!content.includes(SESSION_HOOK_MARKER)) {
        return { configPath, removed: false };
    }

    // Remove [[hooks]] blocks that contain our marker command.
    // A hook block starts with [[hooks]] and ends before the next
    // [[something]] or end of file.
    const lines = content.split('\n');
    const resultLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (line.trim() === '[[hooks]]') {
            // Peek ahead — if this block contains our marker, skip it
            const blockLines = getTomlBlock(lines, i);
            if (blockLines.some((l) => l.includes(SESSION_HOOK_MARKER))) {
                i += blockLines.length;
                continue;
            }
        }

        resultLines.push(line);
        i++;
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

function getTomlBlock(lines: string[], startIndex: number): string[] {
    const block: string[] = [lines[startIndex]];
    for (let i = startIndex + 1; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        if (trimmed.startsWith('[[') || trimmed.startsWith('[')) {
            break;
        }
        block.push(lines[i]);
    }
    return block;
}
