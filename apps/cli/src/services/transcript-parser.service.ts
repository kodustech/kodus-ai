import type { TranscriptSignals, ToolUseSignal } from '../types/memory.js';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

class TranscriptParserService {
    parse(payload: unknown): TranscriptSignals {
        const empty: TranscriptSignals = {
            modifiedFiles: [],
            toolUses: [],
        };

        try {
            if (
                !payload ||
                typeof payload !== 'object' ||
                Array.isArray(payload)
            ) {
                return empty;
            }

            const obj = payload as Record<string, unknown>;

            const sessionId = this.pickString(obj, [
                'session_id',
                'sessionId',
                'thread-id',
                'thread_id',
            ]);
            const turnId = this.pickString(obj, [
                'turn_id',
                'turnId',
                'call_id',
                'callId',
            ]);
            const prompt = this.pickString(obj, ['prompt', 'user_message']);
            const assistantMessage = this.pickString(obj, [
                'last_assistant_message',
                'last-assistant-message',
                'assistant_message',
                'assistant-message',
            ]);

            const toolUses = this.extractToolUses(obj);
            const modifiedFiles = this.extractModifiedFiles(toolUses);

            return {
                sessionId,
                turnId,
                prompt,
                assistantMessage,
                modifiedFiles,
                toolUses,
            };
        } catch {
            return empty;
        }
    }

    private extractToolUses(payload: Record<string, unknown>): ToolUseSignal[] {
        const toolUses: ToolUseSignal[] = [];

        const rawToolUses =
            payload['tool_uses'] ?? payload['toolUses'] ?? payload['tool_use'];
        if (Array.isArray(rawToolUses)) {
            for (const item of rawToolUses) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    continue;
                }
                const entry = item as Record<string, unknown>;
                const tool =
                    typeof entry['tool'] === 'string'
                        ? entry['tool']
                        : typeof entry['name'] === 'string'
                          ? entry['name']
                          : undefined;
                if (!tool) {
                    continue;
                }

                const filePath =
                    typeof entry['file_path'] === 'string'
                        ? entry['file_path']
                        : typeof entry['filePath'] === 'string'
                          ? entry['filePath']
                          : undefined;

                const summary =
                    typeof entry['summary'] === 'string'
                        ? entry['summary']
                        : undefined;

                toolUses.push({ tool, filePath, summary });
            }
        }

        // Also extract from tool_result / content blocks (Claude Code Stop payload format)
        const contentBlocks = payload['content'] ?? payload['messages'];
        if (Array.isArray(contentBlocks)) {
            for (const block of contentBlocks) {
                if (
                    !block ||
                    typeof block !== 'object' ||
                    Array.isArray(block)
                ) {
                    continue;
                }
                const entry = block as Record<string, unknown>;

                if (entry['type'] === 'tool_use') {
                    const tool =
                        typeof entry['name'] === 'string'
                            ? entry['name']
                            : undefined;
                    if (!tool) {
                        continue;
                    }

                    const input = entry['input'] as
                        | Record<string, unknown>
                        | undefined;
                    const filePath =
                        input && typeof input['file_path'] === 'string'
                            ? input['file_path']
                            : undefined;

                    toolUses.push({ tool, filePath });
                }
            }
        }

        return toolUses;
    }

    private extractModifiedFiles(toolUses: ToolUseSignal[]): string[] {
        const files = new Set<string>();

        for (const tu of toolUses) {
            if (WRITE_TOOLS.has(tu.tool) && tu.filePath) {
                files.add(tu.filePath);
            }
        }

        return [...files];
    }

    private pickString(
        payload: Record<string, unknown>,
        keys: string[],
    ): string | undefined {
        for (const key of keys) {
            const value = payload[key];
            if (typeof value === 'string') {
                const trimmed = value.trim();
                if (trimmed) {
                    return trimmed;
                }
            }
        }
        return undefined;
    }
}

export const transcriptParserService = new TranscriptParserService();
