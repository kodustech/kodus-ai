type CommanderExitErrorLike = {
    code: string;
    exitCode: number;
    message?: string;
};

function matchQuotedValue(
    message: string | undefined,
    pattern: RegExp,
): string | undefined {
    const value = message?.match(pattern)?.[1];
    return value && value.length > 0 ? value : undefined;
}

function getProgramName(args: string[]): string {
    if (args.length === 0) {
        return 'kodus';
    }

    if (args[0] === 'config') {
        return 'kodus config';
    }

    return `kodus ${args[0]}`;
}

function formatConfigShortcutMisuse(args: string[]): string | null {
    if (
        args[0] !== 'config' ||
        !(args.includes('-r') || args.includes('--remote')) ||
        !args.includes('setup')
    ) {
        return null;
    }

    const remoteIndex = args.findIndex(
        (arg) => arg === '-r' || arg === '--remote',
    );
    const repository =
        remoteIndex >= 0 &&
        args[remoteIndex + 1] &&
        !args[remoteIndex + 1].startsWith('-') &&
        args[remoteIndex + 1] !== 'setup'
            ? args[remoteIndex + 1]
            : undefined;
    const target = repository ?? '.';

    return [
        "The '-r, --remote' shortcut only adds a repository.",
        `Use \`kodus config -r ${target}\` to add it.`,
        `Use \`kodus config remote setup ${target}\` to run onboarding.`,
    ].join('\n');
}

function formatUnknownCommand(args: string[], message?: string): string {
    const command = matchQuotedValue(message, /unknown command '([^']+)'/i);
    const lines = [
        command
            ? `Unknown command: \`${command}\`.`
            : 'Unknown command.',
        `Run \`${getProgramName(args)} --help\` to see available commands.`,
    ];

    if (args[0] === 'config') {
        lines.push(
            'For repository settings, use `kodus config remote <command>`.',
        );
    }

    return lines.join('\n');
}

export function formatCommanderError(
    error: CommanderExitErrorLike,
    args: string[],
): string {
    const shortcutMisuse = formatConfigShortcutMisuse(args);
    if (shortcutMisuse) {
        return shortcutMisuse;
    }

    if (error.code === 'commander.excessArguments') {
        return `Too many arguments.\nRun \`${getProgramName(args)} --help\` to see the expected syntax.`;
    }

    if (
        error.code === 'commander.unknownOption' ||
        error.message?.includes('unknown option')
    ) {
        const option = matchQuotedValue(error.message, /unknown option '([^']+)'/i);
        return [
            option ? `Unknown option: \`${option}\`.` : 'Unknown option.',
            `Run \`${getProgramName(args)} --help\` to see available options.`,
        ].join('\n');
    }

    if (
        error.code === 'commander.unknownCommand' ||
        error.message?.includes('unknown command')
    ) {
        return formatUnknownCommand(args, error.message);
    }

    if (
        error.code === 'commander.missingArgument' ||
        error.message?.includes('missing required argument')
    ) {
        const argument = matchQuotedValue(
            error.message,
            /missing required argument '([^']+)'/i,
        );
        return [
            argument
                ? `Missing required argument: \`${argument}\`.`
                : 'Missing required argument.',
            `Run \`${getProgramName(args)} --help\` to see the expected syntax.`,
        ].join('\n');
    }

    return error.message ?? 'Command failed.';
}
