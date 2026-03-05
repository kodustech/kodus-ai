#!/usr/bin/env node

/**
 * Pre-processing script for the FP eval:
 * 1. Reads false_positives.jsonl
 * 2. Replaces rationales with original planner-style ones (generic)
 * 3. Calls Gemini API to auto-enrich them (same prompt as production enrichRationales())
 * 4. Writes back to false_positives.jsonl with enriched rationales
 *
 * Usage: GEMINI_API_KEY=xxx node enrich-fp-rationales.js
 */

const fs = require('fs');
const path = require('path');

const FP_FILE = path.join(__dirname, 'datasets_ast', 'false_positives.jsonl');

// Original planner-style rationales — generic, written BEFORE search results are known.
// These simulate what the planner actually produces.
const ORIGINAL_RATIONALES = {
    1: 'Upstream dependency — find db module to understand query interface used by ApiKeyValidator',
    2: 'Consumer/implementation — find BuildPipeline class to verify test assertions match actual behavior',
    3: 'Consumer — find controllers that import BulkImportDto to check if ArrayMaxSize change affects callers',
    4: 'Consumer — find tests that import from e2b mock to verify mock interface matches usage patterns',
    5: 'Consumer — find callers of normalizeSeverity to verify function contract is preserved',
};

async function callEnrichmentAPI(snippets, diffSummary) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY not set');

    const snippetDescriptions = snippets
        .map(
            (s, i) =>
                `[${i}] File: ${s.filePath}${s.relatedSymbol ? ` | Symbol: ${s.relatedSymbol}` : ''} | Original rationale: ${s.rationale}\nCode:\n${s.content.substring(0, 2000)}`,
        )
        .join('\n\n');

    const systemPrompt = `You are a code review context analyst. For each snippet, rewrite the rationale to describe the concrete mechanism the code uses and what concerns it eliminates.

RULES:
- Describe the MECHANISM: what the snippet code does concretely (e.g., "delegates to pg Pool.query with parameterized placeholders", "enforces ArrayMaxSize via NestJS ValidationPipe")
- If the mechanism refutes a common concern, state it: "[Concern] is not an issue because [mechanism]"
- NEVER mention concerns the snippet does NOT refute. If you cannot refute a concern from the snippet, do not mention it at all.
- Keep each rationale to 1-2 sentences. Be specific — name functions, classes, patterns visible in the code.

Diff summary:
${diffSummary}

Snippets:
${snippetDescriptions}

Return a JSON array: [{"index": 0, "rationale": "enriched rationale"}, ...]`;

    const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [
                    {
                        role: 'user',
                        parts: [
                            {
                                text: 'Analyze each snippet and rewrite its rationale based on the actual code content. Return the response as a JSON array.',
                            },
                        ],
                    },
                ],
                generationConfig: {
                    temperature: 0,
                    responseMimeType: 'application/json',
                },
            }),
        },
    );

    if (!response.ok) {
        throw new Error(
            `Gemini API error: ${response.status} ${await response.text()}`,
        );
    }

    const data = await response.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('No response text from Gemini');

    return JSON.parse(text);
}

async function main() {
    const lines = fs.readFileSync(FP_FILE, 'utf-8').split('\n').filter(Boolean);
    const enrichedLines = [];

    for (const line of lines) {
        const data = JSON.parse(line);
        const inputs = data.inputs?.inputs || data.inputs || {};
        const snippets = inputs.crossFileSnippets || [];
        const exIndex = data.metadata?.index;

        if (!snippets.length || !exIndex) {
            enrichedLines.push(JSON.stringify(data));
            continue;
        }

        // Step 1: Replace with original planner rationales
        for (const s of snippets) {
            s.rationale = ORIGINAL_RATIONALES[exIndex] || s.rationale;
        }

        // Step 2: Build diff summary (same truncation as production)
        const diff = inputs.patchWithLinesStr || '';
        const diffSummary =
            diff.length > 500
                ? diff.substring(0, 500) + '\n... (truncated)'
                : diff;

        // Step 3: Call enrichment API
        console.log(`  Ex${exIndex}: enriching ${snippets.length} snippet(s)...`);
        const enriched = await callEnrichmentAPI(snippets, diffSummary);

        // Step 4: Merge enriched rationales back
        let enrichedCount = 0;
        for (const item of enriched) {
            if (
                typeof item.index === 'number' &&
                item.index >= 0 &&
                item.index < snippets.length &&
                typeof item.rationale === 'string' &&
                item.rationale.trim()
            ) {
                snippets[item.index].rationale = item.rationale.trim();
                enrichedCount++;
            }
        }
        console.log(`  Ex${exIndex}: enriched ${enrichedCount}/${snippets.length} rationale(s)`);
        console.log(`    → "${snippets[0].rationale.substring(0, 100)}..."`);

        enrichedLines.push(JSON.stringify(data));
    }

    fs.writeFileSync(FP_FILE, enrichedLines.join('\n') + '\n');
    console.log(`\nWrote ${enrichedLines.length} examples to ${FP_FILE}`);
}

console.log('=== Enriching FP rationales ===');
main().catch((err) => {
    console.error('Error:', err.message);
    process.exit(1);
});
