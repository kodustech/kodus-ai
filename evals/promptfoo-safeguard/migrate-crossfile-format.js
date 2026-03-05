#!/usr/bin/env node

/**
 * One-time migration script: transforms safeguard crossfile JSONL datasets
 * from old format { path, language, snippet } to production format
 * { filePath, relatedSymbol, rationale, content }.
 *
 * Usage: node migrate-crossfile-format.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');

const DATASET_BASE = path.join(__dirname, 'safeguard_datasets');
const DATASET_TYPES = ['no_changes', 'discard', 'update'];
const CROSSFILE_SUFFIXES = [
    'tsjs_crossfile',
    'react_crossfile',
    'java_crossfile',
    'python_crossfile',
    'ruby_crossfile',
];

/**
 * Extract the primary imported symbol from a code snippet.
 * Prioritises imports that come from the changed file's module path.
 */
function extractRelatedSymbol(snippet, changedFilePath) {
    if (!snippet) return undefined;

    const changedBasename = changedFilePath
        ? path.basename(changedFilePath, path.extname(changedFilePath))
        : '';

    // Collect ALL named imports: import { Foo, Bar } from '...'
    const allNamedImports = [
        ...snippet.matchAll(
            /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
        ),
    ];

    // Prefer imports from the changed file
    if (changedBasename && allNamedImports.length > 0) {
        const fromChanged = allNamedImports.find((m) =>
            m[2].includes(changedBasename),
        );
        if (fromChanged) {
            const symbols = fromChanged[1]
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            return symbols[0] || undefined;
        }
    }

    // Fallback: first named import
    if (allNamedImports.length > 0) {
        const symbols = allNamedImports[0][1]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        return symbols[0] || undefined;
    }

    // Default imports — prefer from changed file
    const allDefaults = [
        ...snippet.matchAll(/import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g),
    ];
    if (changedBasename && allDefaults.length > 0) {
        const fromChanged = allDefaults.find((m) =>
            m[2].includes(changedBasename),
        );
        if (fromChanged) return fromChanged[1];
    }
    if (allDefaults.length > 0) return allDefaults[0][1];

    // Java: import com.example.Foo;
    const javaImport = snippet.match(/import\s+[\w.]+\.(\w+)\s*;/);
    if (javaImport) {
        return javaImport[1];
    }

    // Python: from module import Foo
    const pythonImport = snippet.match(/from\s+\S+\s+import\s+(\w+)/);
    if (pythonImport) {
        return pythonImport[1];
    }

    // Ruby: require_relative or require
    const rubyRequire = snippet.match(
        /require(?:_relative)?\s+['"]([^'"]+)['"]/,
    );
    if (rubyRequire) {
        const parts = rubyRequire[1].split('/');
        return parts[parts.length - 1];
    }

    return undefined;
}

/**
 * Generate a rationale for why a cross-file snippet is relevant.
 */
function generateRationale(snippet, snippetPath, changedFilePath) {
    if (!snippet) return 'Related file in the codebase';

    const changedBasename = changedFilePath
        ? path.basename(changedFilePath, path.extname(changedFilePath))
        : '';

    // Check for common patterns
    const hasImport =
        /import\s/.test(snippet) ||
        /require\(/.test(snippet) ||
        /require_relative/.test(snippet);
    const hasClassDef =
        /class\s+\w+/.test(snippet) || /def\s+\w+/.test(snippet);
    const isTest =
        /\.spec\.|\.test\.|test_|_test\./.test(snippetPath) ||
        /\bdescribe\(|\bit\(|\btest\(/.test(snippet);
    const isController = /controller/i.test(snippetPath);
    const isService = /service/i.test(snippetPath);
    const isMiddleware = /middleware/i.test(snippetPath);

    if (isTest) {
        return `Test file — validates behavior of code from ${changedBasename || 'the changed file'}`;
    }
    if (isController) {
        return `Controller — calls methods from ${changedBasename || 'the changed module'}`;
    }
    if (isMiddleware) {
        return `Middleware — uses symbols from ${changedBasename || 'the changed module'}`;
    }
    if (hasImport && isService) {
        return `Consumer service — imports and uses symbols from ${changedBasename || 'the changed module'}`;
    }
    if (hasImport) {
        return `Consumer — imports and depends on symbols from ${changedBasename || 'the changed module'}`;
    }
    if (hasClassDef) {
        return `Related implementation — may be affected by changes in ${changedBasename || 'the changed file'}`;
    }

    return `Related file — may reference or depend on ${changedBasename || 'the changed code'}`;
}

/**
 * Transform a single crossFileSnippet from old format to new format.
 */
function transformSnippet(oldSnippet, changedFilePath) {
    // Already in new format?
    if (oldSnippet.content && oldSnippet.filePath) {
        return oldSnippet;
    }

    const filePath = oldSnippet.path || oldSnippet.filePath || 'unknown';
    const content = oldSnippet.snippet || oldSnippet.content || '';
    const relatedSymbol = extractRelatedSymbol(content, changedFilePath);
    const rationale = generateRationale(content, filePath, changedFilePath);

    const newSnippet = {
        filePath,
        content,
        relatedSymbol: relatedSymbol || undefined,
        rationale,
    };

    // Remove undefined fields for cleaner JSON
    if (!newSnippet.relatedSymbol) delete newSnippet.relatedSymbol;

    return newSnippet;
}

// ─── Main ────────────────────────────────────────────────────────────────────

let totalFiles = 0;
let totalLines = 0;
let totalSnippets = 0;

for (const dsType of DATASET_TYPES) {
    for (const langFile of CROSSFILE_SUFFIXES) {
        const filePath = path.join(DATASET_BASE, dsType, `${langFile}.jsonl`);
        if (!fs.existsSync(filePath)) {
            continue;
        }

        const raw = fs.readFileSync(filePath, 'utf-8');
        const lines = raw.split('\n').filter(Boolean);
        let changed = false;

        const newLines = lines.map((line, idx) => {
            let data;
            try {
                data = JSON.parse(line);
            } catch {
                console.warn(
                    `  WARN: skipping malformed JSON in ${dsType}/${langFile}.jsonl line ${idx + 1}`,
                );
                return line;
            }

            const inputs = data.inputs?.inputs || data.inputs || {};
            const snippets = inputs.crossFileSnippets;
            if (!snippets || !snippets.length) return line;

            const changedFile = inputs.filePath || '';

            // Check if any snippet uses old format
            const hasOldFormat = snippets.some(
                (s) => s.path || s.snippet || s.language,
            );
            if (!hasOldFormat) return line;

            // Transform snippets
            inputs.crossFileSnippets = snippets.map((s) =>
                transformSnippet(s, changedFile),
            );
            totalSnippets += snippets.length;
            changed = true;

            return JSON.stringify(data);
        });

        if (changed) {
            totalFiles++;
            totalLines += lines.length;

            if (DRY_RUN) {
                console.log(
                    `  [DRY-RUN] Would update ${dsType}/${langFile}.jsonl (${lines.length} lines)`,
                );
            } else {
                fs.writeFileSync(filePath, newLines.join('\n') + '\n');
                console.log(
                    `  Updated ${dsType}/${langFile}.jsonl (${lines.length} lines)`,
                );
            }
        }
    }
}

console.log(
    `\n${DRY_RUN ? '[DRY-RUN] ' : ''}Done: ${totalFiles} files, ${totalLines} lines, ${totalSnippets} snippets transformed.`,
);
