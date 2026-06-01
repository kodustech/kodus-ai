import type { Command } from 'commander';

export interface CommandArgumentSchema {
    name: string;
    required: boolean;
    variadic: boolean;
    description?: string;
}

export interface CommandOptionSchema {
    flags: string;
    short?: string;
    long?: string;
    required: boolean;
    optional: boolean;
    description: string;
    defaultValue?: unknown;
}

export interface CommandTreeSchema {
    path: string;
    name: string;
    aliases: string[];
    description: string;
    arguments: CommandArgumentSchema[];
    options: CommandOptionSchema[];
    commands: CommandTreeSchema[];
}

function readArguments(command: Command): CommandArgumentSchema[] {
    const args = ((command as unknown as { registeredArguments?: unknown[] })
        .registeredArguments ?? []) as Array<Record<string, unknown>>;

    return args.map((arg) => ({
        name:
            typeof arg.name === 'function'
                ? String((arg.name as () => string)())
                : String(arg.name ?? ''),
        required: Boolean(arg.required),
        variadic: Boolean(arg.variadic),
        description:
            typeof arg.description === 'string' ? arg.description : undefined,
    }));
}

function readOptions(command: Command): CommandOptionSchema[] {
    return command.options.map((option) => {
        const raw = option as unknown as {
            flags: string;
            short?: string;
            long?: string;
            required?: boolean;
            optional?: boolean;
            mandatory?: boolean;
            description?: string;
            defaultValue?: unknown;
        };

        return {
            flags: raw.flags,
            short: raw.short,
            long: raw.long,
            required: Boolean(raw.mandatory),
            optional: Boolean(raw.optional),
            description: raw.description ?? '',
            defaultValue: raw.defaultValue,
        };
    });
}

export function buildCommandSchema(
    command: Command,
    parentPath = '',
): CommandTreeSchema {
    const name = command.name();
    const path = parentPath ? `${parentPath} ${name}` : name;

    return {
        path,
        name,
        aliases: command.aliases(),
        description: command.description() ?? '',
        arguments: readArguments(command),
        options: readOptions(command),
        commands: command.commands.map((child) =>
            buildCommandSchema(child, path),
        ),
    };
}

function getParentCommand(command: Command): Command | undefined {
    return (command as unknown as { parent?: Command }).parent;
}

export function getCommandPath(command: Command): string {
    const segments: string[] = [];
    let current: Command | undefined = command;

    while (current) {
        const parent = getParentCommand(current);
        if (!parent) {
            break;
        }

        segments.unshift(current.name());
        current = parent;
    }

    return segments.join(' ');
}

function findDirectChildBySegment(
    command: Command,
    segment: string,
): Command | undefined {
    return command.commands.find(
        (child) =>
            child.name() === segment || child.aliases().includes(segment),
    );
}

export function findCommandByPath(
    root: Command,
    rawPath: string,
): Command | null {
    const segments = rawPath.trim().split(/\s+/).filter(Boolean);

    if (segments.length === 0) {
        return root;
    }

    let current = root;
    for (const segment of segments) {
        const next = findDirectChildBySegment(current, segment);
        if (!next) {
            return null;
        }
        current = next;
    }

    return current;
}
