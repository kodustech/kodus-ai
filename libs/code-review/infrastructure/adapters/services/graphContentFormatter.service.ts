import { Injectable } from '@nestjs/common';
import { createLogger } from '@kodus/flow';
import { parsePatch } from 'diff';
import { FileChange } from '@libs/core/infrastructure/config/types/general/codeReview.type';

/** Minimal graph node shape from kodus-graph output. */
interface GraphNode {
    qualified_name: string;
    kind: string;
    file: string;
    line_start: number;
    line_end: number;
}

/** Minimal graph edge shape from kodus-graph output. */
interface GraphEdge {
    caller: string;
    callee: string;
}

/** Graph JSON shape (subset of kodus-graph output). */
export interface GraphJson {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

type ContentFlag = 'diff' | 'simple' | 'full';

const CONTEXT_LINES = 5;
const CUT_MARKER = '\n<- CUT CONTENT ->\n';

@Injectable()
export class GraphContentFormatter {
    private readonly logger = createLogger(GraphContentFormatter.name);

    /**
     * Format file content for LLM review, using graph-aware extraction when available.
     * Returns a Map of filename -> { content, flag }.
     * Files not in the map should use their original fileContent.
     */
    async formatContent(
        files: FileChange[],
        graphJson?: GraphJson,
    ): Promise<Map<string, { content: string; flag: ContentFlag }>> {
        const result = new Map<string, { content: string; flag: ContentFlag }>();

        this.logger.log({
            message: `[GRAPH-FORMAT] Input: ${files.length} files, graphJson=${graphJson ? `${graphJson.nodes.length} nodes, ${graphJson.edges.length} edges` : 'NOT available (Tier 1 disabled)'}`,
            context: GraphContentFormatter.name,
            metadata: { fileCount: files.length, hasGraph: !!graphJson, nodeCount: graphJson?.nodes?.length ?? 0, edgeCount: graphJson?.edges?.length ?? 0 },
        });

        for (const file of files) {
            const content = file.fileContent || file.content || '';
            const patch = file.patch || '';

            if (!content && !patch) continue;

            const formatted = this.formatSingleFile(file.filename, content, patch, graphJson);
            if (formatted) {
                result.set(file.filename, formatted);
            }
        }

        this.logger.log({
            message: `[GRAPH-FORMAT] Formatted ${result.size}/${files.length} files`,
            context: GraphContentFormatter.name,
            metadata: {
                byFlag: {
                    diff: [...result.values()].filter((v) => v.flag === 'diff').length,
                    simple: [...result.values()].filter((v) => v.flag === 'simple').length,
                    full: [...result.values()].filter((v) => v.flag === 'full').length,
                },
            },
        });

        return result;
    }

    private formatSingleFile(
        filename: string,
        content: string,
        patch: string,
        graphJson?: GraphJson,
    ): { content: string; flag: ContentFlag } | null {
        const lines = content.split('\n');

        // Parse changed line ranges from patch
        const changedRanges = this.parseChangedRanges(patch);
        if (changedRanges.length === 0) {
            return { content, flag: 'full' };
        }

        // Tier 1: Graph-aware extraction
        if (graphJson?.nodes?.length) {
            try {
                const graphFormatted = this.formatWithGraph(filename, lines, changedRanges, graphJson);
                if (graphFormatted) {
                    return { content: graphFormatted, flag: 'diff' };
                }
            } catch {
                // Fall through to Tier 2 on any graph formatting error
            }
        }

        // Tier 2: Simple diff context
        const simpleFormatted = this.formatWithSimpleDiff(lines, changedRanges);
        if (simpleFormatted) {
            return { content: simpleFormatted, flag: 'simple' };
        }

        // Tier 3: Full content
        return { content, flag: 'full' };
    }

    private formatWithGraph(
        filename: string,
        lines: string[],
        changedRanges: [number, number][],
        graphJson: GraphJson,
    ): string | null {
        // Find nodes in this file that intersect with changed ranges
        const fileNodes = graphJson.nodes.filter(
            (n) => this.normalizePath(n.file) === this.normalizePath(filename),
        );

        if (fileNodes.length === 0) return null;

        const affectedNodes = fileNodes.filter((node) =>
            changedRanges.some(
                ([start, end]) => node.line_start <= end && node.line_end >= start,
            ),
        );

        if (affectedNodes.length === 0) return null;

        // Follow edges to include direct callers/callees
        const affectedNames = new Set(affectedNodes.map((n) => n.qualified_name));
        const relatedNames = new Set<string>();

        for (const edge of graphJson.edges) {
            if (affectedNames.has(edge.caller)) relatedNames.add(edge.callee);
            if (affectedNames.has(edge.callee)) relatedNames.add(edge.caller);
        }

        // Collect all nodes to include (affected + related in same file)
        const relatedNodes = fileNodes.filter(
            (n) => relatedNames.has(n.qualified_name) && !affectedNames.has(n.qualified_name),
        );

        const allNodes = [...affectedNodes, ...relatedNodes];
        allNodes.sort((a, b) => a.line_start - b.line_start);

        // Build snippets with line numbers
        const ranges = this.mergeRanges(
            allNodes.map((n) => [n.line_start, n.line_end] as [number, number]),
        );

        const snippets = ranges.map(([start, end]) => {
            const slice = lines.slice(start - 1, end);
            return slice
                .map((line, i) => `${start + i}: ${line}`)
                .join('\n');
        });

        return snippets.join(CUT_MARKER);
    }

    private formatWithSimpleDiff(
        lines: string[],
        changedRanges: [number, number][],
    ): string | null {
        // Expand each range by CONTEXT_LINES
        const expanded = changedRanges.map(
            ([start, end]) =>
                [
                    Math.max(1, start - CONTEXT_LINES),
                    Math.min(lines.length, end + CONTEXT_LINES),
                ] as [number, number],
        );

        const merged = this.mergeRanges(expanded);

        const snippets = merged.map(([start, end]) => {
            const slice = lines.slice(start - 1, end);
            return slice
                .map((line, i) => `${start + i}: ${line}`)
                .join('\n');
        });

        return snippets.length > 0 ? snippets.join(CUT_MARKER) : null;
    }

    private parseChangedRanges(patch: string): [number, number][] {
        if (!patch) return [];

        try {
            const parsed = parsePatch(patch);
            const ranges: [number, number][] = [];

            for (const file of parsed) {
                for (const hunk of file.hunks) {
                    const start = hunk.newStart;
                    const end =
                        hunk.newLines > 0 ? start + hunk.newLines - 1 : start;
                    if (start > 0 && end >= start) {
                        ranges.push([start, end]);
                    }
                }
            }

            return ranges;
        } catch {
            return [];
        }
    }

    private mergeRanges(ranges: [number, number][]): [number, number][] {
        if (ranges.length === 0) return [];

        const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
        const merged: [number, number][] = [sorted[0]];

        for (let i = 1; i < sorted.length; i++) {
            const last = merged[merged.length - 1];
            if (sorted[i][0] <= last[1] + 1) {
                last[1] = Math.max(last[1], sorted[i][1]);
            } else {
                merged.push(sorted[i]);
            }
        }

        return merged;
    }

    private normalizePath(p: string | undefined): string {
        return (p || '').replace(/^\.\//, '').replace(/\\/g, '/');
    }
}
