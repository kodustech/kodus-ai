function stripCodeBlocks(text) {
    const cleanText = String(text || '').trim();
    const jsonMatches = cleanText.matchAll(/```json([\s\S]*?)```/g);

    for (const match of jsonMatches) {
        const content = match[1].trim();
        try {
            JSON.parse(content);
            return content;
        } catch {
            // continue
        }
    }

    const genericMatches = cleanText.matchAll(/```(?:\w*)\s*([\s\S]*?)```/g);
    for (const match of genericMatches) {
        const content = match[1].trim();
        if (content.startsWith('{') || content.startsWith('[')) {
            return content;
        }
    }

    return cleanText;
}

function tryParseObject(payload) {
    const candidate = stripCodeBlocks(payload)
        .replace(/^['"]|['"]$/g, '')
        .trim();

    if (!candidate) {
        return null;
    }

    try {
        return JSON.parse(candidate);
    } catch {
        return null;
    }
}

function flattenToolCalls(parsed) {
    if (!parsed) {
        return [];
    }

    const result = [];

    if (parsed.action && typeof parsed.action === 'object') {
        const action = parsed.action;
        if (
            action.type === 'tool_call' &&
            (action.toolName || action.name || action.tool)
        ) {
            result.push({
                name: String(action.toolName || action.name || action.tool),
                input: action.input || action.args || {},
            });
        }
    }

    if (Array.isArray(parsed.hypotheses)) {
        for (const hypothesis of parsed.hypotheses) {
            const action = hypothesis?.action;
            if (
                action?.type === 'tool_call' &&
                (action.toolName || action.name || action.tool)
            ) {
                result.push({
                    name: String(
                        action.toolName || action.name || action.tool,
                    ),
                    input: action.input || action.args || {},
                });
            }
        }
    }

    if (Array.isArray(parsed.actions)) {
        for (const action of parsed.actions) {
            const toolName = action?.toolName || action?.name || action?.tool;
            const type = action?.type || '';
            if (toolName && (type === 'tool' || !type || type === 'tool_call')) {
                result.push({
                    name: String(toolName),
                    input: action?.input || action?.args || {},
                });
            }
        }
    }

    if (Array.isArray(parsed.toolCalls)) {
        for (const call of parsed.toolCalls) {
            const toolName = call?.toolName || call?.name || call?.tool;
            if (toolName) {
                result.push({
                    name: String(toolName),
                    input: call?.input || call?.args || {},
                });
            }
        }
    }

    return result;
}

function detectToolCalls(output) {
    const parsed = tryParseObject(output);
    const parsedToolCalls = flattenToolCalls(parsed);

    if (parsedToolCalls.length > 0) {
        return parsedToolCalls;
    }

    const text = String(output || '');
    if (/KODUS_CREATE_MEMORY/i.test(text)) {
        return [{ name: 'KODUS_CREATE_MEMORY', input: {} }];
    }

    return [];
}

module.exports = {
    detectToolCalls,
    tryParseObject,
    stripCodeBlocks,
};
