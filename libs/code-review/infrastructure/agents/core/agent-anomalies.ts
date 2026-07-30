/**
 * code-review (domain) — derive run anomaly flags from the agent's investigation.
 *
 * Relocated from the legacy llm/agent-loop.ts so core-agent-loop.adapter doesn't
 * reach into the 4.5k-line legacy file just for buildAgentAnomalies.
 */
import { CoverageSummary } from '@libs/code-review/infrastructure/agents/engine/coverage-ledger';
import type {
    AgentLoopOutput,
    AgentAnomalySummary,
    ToolEvidenceSummary,
} from '@libs/code-review/infrastructure/agents/review-agent.contract';

function normalizeFilePath(filePath: string): string {
    if (!filePath) return '';
    return filePath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/^\/+/, '')
        .trim()
        .toLowerCase();
}

export function buildToolEvidenceSummary(
    toolCalls: AgentLoopOutput['toolCalls'],
): ToolEvidenceSummary {
    const strongFiles = new Set<string>();
    const weakFiles = new Set<string>();

    for (const toolCall of toolCalls) {
        const normalizedTool = (toolCall.toolName || toolCall.tool || '')
            .trim()
            .toLowerCase();
        const args = (toolCall.args || {}) as Record<string, unknown>;

        if (normalizedTool === 'readfile' || normalizedTool === 'checktypes') {
            const explicitPath =
                (args.path as string) ||
                (args.filePath as string) ||
                (args.file as string) ||
                '';
            const normalizedPath = normalizeFilePath(explicitPath);
            if (normalizedPath) {
                strongFiles.add(normalizedPath);
            }
        }

        if (normalizedTool === 'grep' && typeof toolCall.result === 'string') {
            for (const resultLine of toolCall.result.split('\n')) {
                const match = resultLine.match(/^([^:]+):\d+:/);
                if (!match?.[1]) continue;
                const normalizedPath = normalizeFilePath(match[1]);
                if (normalizedPath) {
                    weakFiles.add(normalizedPath);
                }
            }
        }
    }

    return {
        strongFiles: [...strongFiles],
        weakFiles: [...weakFiles],
    };
}

export function buildAgentAnomalies(params: {
    steps: number;
    toolCalls: AgentLoopOutput['toolCalls'];
    coverage: CoverageSummary;
}): AgentAnomalySummary {
    const { steps, toolCalls, coverage } = params;
    const evidence = buildToolEvidenceSummary(toolCalls);
    const touchedTargets = coverage?.touchedTargets || 0;
    const totalTargets = coverage?.totalTargets || 0;
    const coveragePct = totalTargets > 0 ? touchedTargets / totalTargets : 0;

    return {
        stepsLe2: steps <= 2,
        zeroToolCalls: toolCalls.length === 0,
        zeroStrongEvidenceFiles: evidence.strongFiles.length === 0,
        zeroCoverage: touchedTargets === 0,
        lowCoverage: totalTargets > 0 && coveragePct < 0.7,
        lowStrongEvidenceFiles:
            totalTargets >= 2 && evidence.strongFiles.length < 2,
    };
}
