const OPTIONS_WITH_VALUES = new Set(['-f', '--format', '-o', '--output']);

/**
 * `kodus trace <paths>` reads, `kodus trace enable` runs the subcommand, and a
 * path that collides with a subcommand name is disambiguated with `--`.
 *
 * Commander resolves a registered subcommand before it ever looks at the
 * parent's arguments, and it strips `--` without marking what followed it, so
 * the disambiguation has to happen before parsing. Everything after `--` is
 * rewritten into repeated `--path` options, which leaves the operand list empty
 * and sends the invocation to the group's own action handler.
 */
export function normalizeTraceArgv(argv: string[]): string[] {
    const commandIndex = findTraceCommandIndex(argv);
    if (commandIndex === -1) {
        return argv;
    }

    const separatorIndex = argv.indexOf('--', commandIndex + 1);
    if (separatorIndex === -1) {
        return argv;
    }

    const before = argv.slice(0, separatorIndex);
    const after = argv.slice(separatorIndex + 1);

    return [...before, ...after.flatMap((value) => ['--path', value])];
}

function findTraceCommandIndex(argv: string[]): number {
    let index = 2; // node, script

    while (index < argv.length) {
        const token = argv[index];

        if (token === '--') {
            return -1;
        }

        if (token.startsWith('-')) {
            // `--format=json` carries its value inline; `-f json` does not.
            if (OPTIONS_WITH_VALUES.has(token)) {
                index += 2;
            } else {
                index += 1;
            }
            continue;
        }

        return token === 'trace' ? index : -1;
    }

    return -1;
}
