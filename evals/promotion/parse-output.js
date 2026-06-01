function parseOutput(output) {
    try {
        const cleaned = String(output || '')
            .replace(/^```json\s*/i, '')
            .replace(/```\s*$/i, '')
            .trim();
        return JSON.parse(cleaned);
    } catch {
        return null;
    }
}

module.exports = { parseOutput };
