import { Injectable } from '@nestjs/common';

import {
    AnalyzerTool,
    RouteDecision,
    ToolRouteInput,
} from './tool.contract';

/**
 * Decides which deterministic tools apply to a change.
 *
 * Three rules, in order:
 *   1. configuration — an unset tool is off, so a deterministic pass is always
 *      opted into rather than appearing on someone's PRs unannounced;
 *   2. relevance — a tool that claims none of the changed files never runs,
 *      which is what keeps the added latency proportional to the change;
 *   3. duplication — on `auto`, a tool whose category the customer's CI
 *      already covers stands down.
 *
 * Every registered tool yields a decision, including the skipped ones. A tool
 * that found nothing and a tool that never ran are indistinguishable from the
 * findings alone, and only the recorded reason tells them apart.
 */
@Injectable()
export class AnalyzerToolRouter {
    route(tools: AnalyzerTool[], input: ToolRouteInput): RouteDecision[] {
        return tools.map((tool) => this.decide(tool, input));
    }

    private decide(
        tool: AnalyzerTool,
        input: ToolRouteInput,
    ): RouteDecision {
        const mode = input.modes?.[tool.id] ?? 'off';

        // Checked before file selection: a disabled tool is never asked to
        // inspect the change.
        if (mode === 'off') {
            return {
                toolId: tool.id,
                run: false,
                reason: 'disabled-by-config',
                fileCount: 0,
            };
        }

        const files = tool.selectFiles(input.changedFiles ?? []);
        if (files.length === 0) {
            return {
                toolId: tool.id,
                run: false,
                reason: 'no-matching-files',
                fileCount: 0,
            };
        }

        const coveredByCi =
            mode === 'auto' &&
            tool.coverage !== undefined &&
            (input.ciCoveredTools ?? []).includes(tool.coverage);

        if (coveredByCi) {
            return {
                toolId: tool.id,
                run: false,
                reason: 'covered-by-ci',
                fileCount: files.length,
            };
        }

        return { toolId: tool.id, run: true, fileCount: files.length };
    }
}
