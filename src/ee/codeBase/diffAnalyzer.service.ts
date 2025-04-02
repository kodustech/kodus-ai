import { Injectable } from '@nestjs/common';
import * as path from 'path';
import { FunctionAnalysis } from './ast/contracts/CodeGraph';
import { SyntaxNode } from 'tree-sitter';

// Basic interfaces needed
interface DiffHunk {
    oldStart: number; // Starting line in the old version
    oldCount: number; // Number of lines in the old version
    newStart: number; // Starting line in the new version
    newCount: number; // Number of lines in the new version
    content: string; // Hunk content with +/− markers
}

interface DiffInfo {
    filePath: string; // File path
    hunks: DiffHunk[]; // Diff hunks
}

export interface ChangeResult {
    added: FunctionResult[];
    modified: FunctionResult[];
    deleted: FunctionResult[];
}

export interface FunctionResult {
    name: string;
    fullName: string;
    functionHash: string;
    signatureHash: string;
    node: SyntaxNode;
    fullText: string;
    lines: number;
}

// Local interface to represent a function with its lines
export interface ExtendedFunctionInfo extends Omit<FunctionAnalysis, 'name'> {
    name: string;
    startLine: number;
    endLine: number;
}

@Injectable()
export class DiffAnalyzerService {
    private readonly patterns = [
        /(?:export\s+)?(?:async\s+)?function\s+(\w+)/, // function declaration
        /(?:public|private|protected)\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*{/, // method declaration
        /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function/, // function expression
        /(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>/, // arrow function
        /private\s+async\s+(\w+)\s*\([^)]*\)\s*{/, // private async method declaration
    ];

    /**
     * Extracts functions from a file based on the code graph
     */
    private extractFileFunctions(
        codeGraphFunctions: Map<string, FunctionAnalysis>,
        filePath: string,
    ): ExtendedFunctionInfo[] {
        if (!codeGraphFunctions) {
            return [];
        }

        const normalizedPath = path.normalize(filePath);

        const funcs = Array.from(codeGraphFunctions.entries())
            .filter(([_, func]) =>
                this.isMatchingFile(func.file, normalizedPath),
            )
            .map(([key, func]) => ({
                ...func,
                name: key.split(':').pop() || 'unknown',
                startLine: (func as any).startLine || 0,
                endLine: (func as any).endLine || 0,
            }));

        return funcs;
    }

    /**
     * Checks if two file paths match
     */
    private isMatchingFile(file1: string, file2: string): boolean {
        // Normalize paths for comparison
        const norm1 = path.normalize(file1);
        const norm2 = path.normalize(file2);

        // Compare the normalized paths exactly
        return norm1 === norm2;
    }

    /**
     * Processes a hunk to identify affected functions
     */
    private processHunk(
        hunk: DiffHunk,
        fileFunctions: ExtendedFunctionInfo[],
        result: ChangeResult,
    ): void {
        // Determine the range of lines affected by the hunk
        const hunkStartLine = hunk.oldStart;
        const hunkEndLine = hunk.oldStart + hunk.oldCount - 1;

        // Check which functions are affected by this hunk
        for (const func of fileFunctions) {
            // Check if the hunk intersects with the function
            if (this.isHunkAffectingFunction(hunk, func)) {
                if (
                    !result.modified.includes({
                        name: func.name,
                        fullName: `${func.className}.${func.name}`,
                        functionHash: func.functionHash,
                        signatureHash: func.signatureHash,
                        node: func.bodyNode,
                        fullText: func.fullText,
                        lines: func.lines,
                    })
                ) {
                    result.modified.push({
                        name: func.name,
                        fullName: `${func.className}.${func.name}`,
                        functionHash: func.functionHash,
                        signatureHash: func.signatureHash,
                        node: func.bodyNode,
                        fullText: func.fullText,
                        lines: func.lines,
                    });
                }
            }
        }
    }

    /**
     * Checks if a hunk affects a function
     */
    private isHunkAffectingFunction(
        hunk: DiffHunk,
        func: ExtendedFunctionInfo,
    ): boolean {
        const hunkStartLine = hunk.oldStart;
        const hunkEndLine = hunk.oldStart + hunk.oldCount - 1;

        // Check if there is overlap between the hunk and the function
        const isOverlapping =
            // Hunk starts within the function
            (hunkStartLine >= func.startLine &&
                hunkStartLine <= func.endLine) ||
            // Hunk ends within the function
            (hunkEndLine >= func.startLine && hunkEndLine <= func.endLine) ||
            // Hunk completely encompasses the function
            (hunkStartLine <= func.startLine && hunkEndLine >= func.endLine);

        // Check if the hunk has real additions or deletions (not just context)
        const hasRealChanges = hunk.content
            .split('\n')
            .some((line) => line.startsWith('+') || line.startsWith('-'));

        return isOverlapping && hasRealChanges;
    }

    private isCodeFile(filePath: string): boolean {
        const codeExtensions = [
            '.ts',
            '.js',
            '.tsx',
            '.jsx',
            '.py',
            '.java',
            '.c',
            '.cpp',
            '.cs',
        ];
        const ext = path.extname(filePath).toLowerCase();
        return codeExtensions.includes(ext);
    }

    private getDirectoryFromFilePath(filePath: string): string {
        return path.dirname(filePath);
    }

    /**
     * Method for compatibility with existing code in analyze-code.use-case.ts
     * @param diff Diff in text format
     * @param completeFile File content
     * @param codeGraph Code graph
     */
    async analyzeDiff(
        prContent: {
            diff: string;
            headCodeGraphFunctions: Map<string, FunctionAnalysis>;
            prFilePath: string;
        },
        baseContent: {
            baseCodeGraphFunctions: Map<string, FunctionAnalysis>;
            baseFilePath: string;
        },
    ): Promise<ChangeResult> {
        const result: ChangeResult = {
            added: [],
            modified: [],
            deleted: [],
        };

        try {
            // Extract functions from the file in both graphs
            const prFunctions = this.extractFileFunctions(
                prContent.headCodeGraphFunctions,
                prContent.prFilePath,
            );
            const baseFunctions = this.extractFileFunctions(
                baseContent.baseCodeGraphFunctions,
                baseContent.baseFilePath,
            );

            const prFunctionMap = new Map(prFunctions.map((f) => [f.name, f]));
            const baseFunctionMap = new Map(
                baseFunctions.map((f) => [f.name, f]),
            );

            for (const [name, func] of prFunctionMap) {
                if (!baseFunctionMap.has(name)) {
                    result.added.push({
                        name: func.name,
                        fullName: `${func.className}.${func.name}`,
                        functionHash: func.functionHash,
                        signatureHash: func.signatureHash,
                        node: func.bodyNode,
                        fullText: func.fullText,
                        lines: func.lines,
                    });
                }
            }
            for (const [name, func] of baseFunctionMap) {
                if (!prFunctionMap.has(name)) {
                    result.deleted.push({
                        name,
                        fullName: `${func.className}.${func.name}`,
                        functionHash: func.functionHash,
                        signatureHash: func.signatureHash,
                        node: func.bodyNode,
                        fullText: func.fullText,
                        lines: func.lines,
                    });
                }
            }

            const hunks = this.parseHunks(prContent.diff);
            for (const hunk of hunks) {
                for (const func of prFunctions) {
                    const fullName = `${func.className}.${func.name}`;
                    if (
                        this.isHunkAffectingFunction(hunk, func) &&
                        !result.added.some(
                            (item) => item.fullName === fullName,
                        ) &&
                        !result.deleted.some(
                            (item) => item.fullName === fullName,
                        ) &&
                        !result.modified.some(
                            (item) => item.fullName === fullName,
                        )
                    ) {
                        result.modified.push({
                            name: func.name,
                            fullName,
                            functionHash: func.functionHash,
                            signatureHash: func.signatureHash,
                            node: func.bodyNode,
                            fullText: func.fullText,
                            lines: func.lines,
                        });
                    }
                }
            }

            return result;
        } catch (error) {
            console.error('Error analyzing diff:', error);
            return result;
        }
    }

    private parseHunks(diff: string): DiffHunk[] {
        const hunks: DiffHunk[] = [];
        const hunkRegex = /@@ -(\d+),(\d+) \+(\d+),(\d+) @@([\s\S]+?)(?=@@|$)/g;

        let match;
        while ((match = hunkRegex.exec(diff)) !== null) {
            hunks.push({
                oldStart: parseInt(match[1], 10),
                oldCount: parseInt(match[2], 10),
                newStart: parseInt(match[3], 10),
                newCount: parseInt(match[4], 10),
                content: match[5].trim(),
            });
        }

        return hunks;
    }
}
