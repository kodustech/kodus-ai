import { Injectable } from '@nestjs/common';
// Make sure you have installed and configured the 'tree-sitter' package with its types,
// or define the necessary types for Tree and SyntaxNode.
import { Tree, SyntaxNode } from 'tree-sitter';

/**
 * Class that represents a span with a start and end.
 */
export class Span {
    constructor(
        public start: number,
        public end: number,
    ) {}

    get length(): number {
        return this.end - this.start;
    }

    /**
     * Returns a new string extracted from the sourceCode based on the span.
     * @param sourceCode The complete source code (as a string)
     */
    extract(sourceCode: string): string {
        return sourceCode.slice(this.start, this.end);
    }
}

/**
 * Returns the length of the string after removing all whitespace characters.
 */
function nonWhitespaceLen(s: string): number {
    return s.replace(/\s/g, '').length;
}

/**
 * Converts a byte offset to the corresponding line number in the sourceCode.
 */
function getLineNumber(byteOffset: number, sourceCode: string): number {
    // Assumes that each '\n' indicates a new line.
    return sourceCode.slice(0, byteOffset).split('\n').length;
}

@Injectable()
export class ChunkerService {
    /**
     * Splits the source code into "chunks" based on the structure of the syntax tree (tree-sitter).
     *
     * @param tree The syntax tree obtained via tree-sitter.
     * @param sourceCode The complete source code as a string.
     * @param MAX_CHARS Maximum number of characters per chunk (default: 512*3).
     * @param coalesce If a chunk has fewer than `coalesce` non-whitespace characters, it will be merged with the next one.
     * @returns An array of spans with the start and end line numbers of each chunk.
     */
    chunker(
        tree: Tree,
        sourceCode: string,
        MAX_CHARS: number = 512 * 3,
        coalesce: number = 50,
    ): Span[] {
        // 1. Recursively forms chunks based on the tree
        const chunkNode = (node: SyntaxNode): Span[] => {
            const chunks: Span[] = [];
            // Create an initial chunk starting at the beginning of the node
            let currentChunk = new Span(node.startIndex, node.startIndex);
            const nodeChildren = node.children;
            for (const child of nodeChildren) {
                const childLength = child.endIndex - child.startIndex;
                if (childLength > MAX_CHARS) {
                    // If the child is too large, finalize the current chunk and process this node recursively
                    chunks.push(currentChunk);
                    currentChunk = new Span(child.endIndex, child.endIndex);
                    chunks.push(...chunkNode(child));
                } else if (childLength + currentChunk.length > MAX_CHARS) {
                    // If adding the child exceeds the limit, finalize the current chunk and start a new one
                    chunks.push(currentChunk);
                    currentChunk = new Span(child.startIndex, child.endIndex);
                } else {
                    // Otherwise, extend the current chunk to include the child
                    currentChunk.end = child.endIndex;
                }
            }
            chunks.push(currentChunk);
            return chunks;
        };

        let chunks = chunkNode(tree.rootNode);

        // 2. Filling the gaps:
        // For each consecutive pair, adjust the end of the previous chunk to match the start of the next one.
        for (let i = 0; i < chunks.length - 1; i++) {
            chunks[i].end = chunks[i + 1].start;
        }
        // For the last chunk, set its start to match the end of the tree
        if (chunks.length > 0) {
            chunks[chunks.length - 1].start = tree.rootNode.endIndex;
        }

        // 3. Combine small chunks with larger ones
        const newChunks: Span[] = [];
        let currentChunk = new Span(0, 0);
        for (const chunk of chunks) {
            if (currentChunk.length === 0) {
                currentChunk = new Span(chunk.start, chunk.end);
            } else {
                // "currentChunk += chunk" is equivalent to extending currentChunk to the end of the current chunk
                currentChunk.end = chunk.end;
            }
            const extracted = currentChunk.extract(sourceCode);
            if (
                nonWhitespaceLen(extracted) > coalesce &&
                extracted.includes('\n')
            ) {
                newChunks.push(currentChunk);
                // Reset currentChunk starting from the end of the current chunk
                currentChunk = new Span(chunk.end, chunk.end);
            }
        }
        if (currentChunk.length > 0) {
            newChunks.push(currentChunk);
        }

        // 4. Convert the offsets into line numbers
        const lineChunks = newChunks.map(
            (chunk) =>
                new Span(
                    getLineNumber(chunk.start, sourceCode),
                    getLineNumber(chunk.end, sourceCode),
                ),
        );

        // 5. Remove empty chunks (with zero length)
        const finalChunks = lineChunks.filter((chunk) => chunk.length > 0);

        return finalChunks;
    }
}
