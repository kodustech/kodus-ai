import * as crypto from 'crypto';
import { SyntaxNode } from 'tree-sitter';

export function normalizeAST(node: SyntaxNode): string {
    if (!node) {
        return '';
    }

    if (node.type === 'comment' || node.type === 'whitespace') {
        return '';
    }
    // Replaces identifiers with a fixed token to ignore specific names
    if (node.type === 'identifier') {
        return 'IDENTIFIER';
    }
    if (node.childCount === 0) {
        if (node.type === 'number' || node.type === 'string') {
            return node.type.toUpperCase();
        }
        return node.type;
    }
    // Concatenates child tokens to preserve the structure
    let normalizedChildren: string[] = [];
    for (let i = 0; i < node.childCount; i++) {
        const child = node.child(i);
        if (child) {
            const normalizedChild = normalizeAST(child);
            if (normalizedChild) {
                normalizedChildren.push(normalizedChild);
            }
        }
    }
    return `${node.type}(${normalizedChildren.join(',')})`;
}

export function normalizeParameter(paramText: string): string {
    const colonIndex = paramText.indexOf(':');
    if (colonIndex !== -1) {
        // Returns everything after the first ':' and removes extra spaces
        return paramText.substring(colonIndex + 1).trim();
    }
    return 'any';
}

export function normalizeSignature(
    params: string[],
    returnType: string,
): string {
    // Normalizes and sorts the parameters to ensure order does not matter
    const normalizedParams = params
        .map(normalizeParameter)
        .sort() // Sorts the normalized parameters
        .join(',');
    const signature = `(${normalizedParams})=>${returnType}`;
    return crypto.createHash('sha256').update(signature).digest('hex');
}
