/**
 * code-review — OutlineFirstReadTool decorator (gated, default off).
 *
 * For a range-LESS readFile on a large file, return a symbol OUTLINE (top-level
 * declarations + line numbers) plus an expand hint instead of dumping the head
 * of the file. The agent then reads only the region it actually needs — the
 * paper's "outline-first" lever: trade a cheap local re-read for far fewer model
 * tokens. An explicit range, a small file, a missing path, an unreadable file,
 * or a file with no recognizable symbols all fall through to the underlying
 * readFile unchanged (no behavior change in those cases).
 *
 * Decorator over the AgentTool port (SRP/OCP/LSP). It is domain-specific — it
 * knows TS/JS declaration shapes — so it lives in code-review, not the generic
 * harness. Composed INSIDE the cache: Caching(OutlineFirst(readFile)).
 */
import type {
    AgentTool,
    ToolContext,
    ToolResult,
} from '@libs/agent-harness/domain/contracts/tool.contract';

export interface OutlineFirstReadOptions {
    /** Read a file's full contents (e.g. remoteCommands.read(path, 0, 0)). */
    readFull: (path: string) => Promise<string>;
    /** Files at/under this line count are read normally (default 150). */
    minLines?: number;
}

const MAX_OUTLINE_ENTRIES = 100;

/** Top-level structural declarations + exported bindings (TS/JS-leaning). */
const DECLARATION =
    /^(export\s+)?(default\s+)?(abstract\s+)?(async\s+)?(function\*?|class|interface|type|enum|namespace)\s+[\w$]+/;
const EXPORTED_BINDING = /^export\s+(const|let|var)\s+[\w$]+/;

function buildOutline(
    path: string,
    content: string,
    lineCount: number,
): string | null {
    const lines = content.split('\n');
    const entries: string[] = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (DECLARATION.test(line) || EXPORTED_BINDING.test(line)) {
            entries.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
            if (entries.length >= MAX_OUTLINE_ENTRIES) {
                entries.push(
                    '… (more symbols omitted — read a region to see them)',
                );
                break;
            }
        }
    }
    if (entries.length === 0) {
        return null; // not a recognizable code file — caller falls back
    }
    return (
        `Outline of ${path} (${lineCount} lines — too large to dump in full). ` +
        `Top-level symbols with line numbers below; call ` +
        `readFile("${path}", startLine, endLine) to read the region you need:\n` +
        entries.join('\n')
    );
}

export class OutlineFirstReadTool implements AgentTool {
    readonly name: string;
    readonly description: string;
    readonly inputSchema: AgentTool['inputSchema'];

    constructor(
        private readonly inner: AgentTool,
        private readonly options: OutlineFirstReadOptions,
    ) {
        this.name = inner.name;
        this.description = inner.description;
        this.inputSchema = inner.inputSchema;
    }

    async execute(input: unknown, ctx: ToolContext): Promise<ToolResult> {
        const args = (input ?? {}) as Record<string, any>;
        const path: string = args.path || args.filePath || args.file || '';
        const startLine = args.startLine || args.start_line || 0;
        const endLine = args.endLine || args.end_line || 0;

        // Only intervene on a range-LESS read of a known path; an explicit range
        // is exactly what the agent wants — honor it untouched.
        if (!path || startLine || endLine) {
            return this.inner.execute(input, ctx);
        }

        let content: string;
        try {
            content = await this.options.readFull(path.replace(/^\/+/, ''));
        } catch {
            // Read failed here — let the underlying tool produce its own error.
            return this.inner.execute(input, ctx);
        }

        const lineCount = content.split('\n').length;
        const minLines = this.options.minLines ?? 150;
        if (lineCount <= minLines) {
            return this.inner.execute(input, ctx); // small file → normal read
        }

        const outline = buildOutline(path, content, lineCount);
        if (!outline) {
            return this.inner.execute(input, ctx); // no symbols → normal read
        }
        return {
            output: outline,
            meta: { outlineFirst: true, lines: lineCount },
        };
    }
}
