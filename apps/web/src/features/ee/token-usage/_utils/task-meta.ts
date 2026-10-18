import { TASK_LABELS } from "../../byok/_utils";

/** Task labels + descriptions (the `LlmTask` set in libs/llm/byok-config.ts).
 *  A task is WHICH model the org picked — the config axis. `''` = unattributable. */
export const TASK_META: Record<string, { label: string; description: string }> = {
    codeReview: {
        label: "Code Review",
        description:
            "The defect-finding review agents plus suggestion refinement and cross-file context — the model you set for Code Review.",
    },
    kodyRulesReview: {
        label: "Kody Rules Review",
        description:
            "Enforcing your Kody Rules on the diff — the model set for Kody Rules Review (inherits Code Review's when unset).",
    },
    prSummary: {
        label: "PR Summary",
        description: "Writing the PR summary comment — the model set for PR Summary.",
    },
    businessValidation: {
        label: "Business Validation",
        description:
            "The business-rules validation agent — the model set for Business Validation.",
    },
    ruleGeneration: {
        label: "Rule Generation",
        description: "Generating and learning Kody Rules from PR history and feedback.",
    },
    conversation: {
        label: "Conversation",
        description: "Answering your @kody replies in review threads.",
    },
    customAgent: {
        label: TASK_LABELS.customAgent,
        description:
            "The review agents your team created. Each one reads the PRs its file patterns match and writes findings — the model set for Custom Agents, or the one an agent pins.",
    },
    customAgentCheck: {
        label: TASK_LABELS.customAgentCheck,
        description:
            "A second pass that re-reads each custom agent finding against the code and drops the ones it cannot confirm, before anything is posted — the model set for Custom Agents: finding check.",
    },
    "": {
        label: "Unrouted",
        description:
            "Spend not attributable to a routing task — internal/system steps, or older runs recorded before per-task routing.",
    },
};

/** The task a row is shown under: a known task, or "" (Unrouted). */
export const taskKeyOf = (task: string): string =>
    task in TASK_META ? task : "";
