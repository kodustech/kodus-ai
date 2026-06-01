const colors = {
    reset: "\x1b[0m",
    blue: "\x1b[34m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    gray: "\x1b[90m",
};

const useColor =
    process.stdout.isTTY && process.env.NO_COLOR !== "1" && process.env.CI !== "false";

function paint(color: keyof typeof colors, text: string): string {
    return useColor ? `${colors[color]}${text}${colors.reset}` : text;
}

function timestamp(): string {
    return new Date().toISOString().slice(11, 19);
}

function emit(
    level: "info" | "ok" | "warn" | "err" | "debug",
    scope: string,
    msg: string,
): void {
    const prefix: Record<typeof level, string> = {
        info: paint("blue", "[info]"),
        ok: paint("green", "[ok]  "),
        warn: paint("yellow", "[warn]"),
        err: paint("red", "[err] "),
        debug: paint("gray", "[dbg] "),
    };
    const stream = level === "err" ? console.error : console.log;
    stream(`${paint("gray", timestamp())} ${prefix[level]} ${paint("gray", `[${scope}]`)} ${msg}`);
}

export function logger(scope: string) {
    return {
        info: (msg: string) => emit("info", scope, msg),
        ok: (msg: string) => emit("ok", scope, msg),
        warn: (msg: string) => emit("warn", scope, msg),
        err: (msg: string) => emit("err", scope, msg),
        debug: (msg: string) => {
            if (process.env.E2E_DEBUG === "1") emit("debug", scope, msg);
        },
    };
}

export type Logger = ReturnType<typeof logger>;
