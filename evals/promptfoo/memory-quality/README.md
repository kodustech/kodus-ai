# Memory Quality Eval Suite (Complex v2)

This suite is **fully isolated** from existing memory eval datasets and scripts.

## What this evaluates

- Memory payload quality: whether extracted memory text captures user intent
- Robustness: ability to ignore unrelated code in retrieved context
- Tool-call quality: whether the memory creation payload is well-structured

## Production-aligned context injection

This suite now mirrors the real conversation flow used in code review replies:

- `prompt` sent to the agent is the single user message (`prepareContext.userQuestion`)
- context is injected through `userContext.additional_information`
- `additional_information` is shaped like production `prepareContext` from the Git conversation flow, including:
    - `repository`, `pullRequest`, `platformType`
    - `codeManagementContext.originalComment.suggestionFilePath`
    - `codeManagementContext.originalComment.suggestionText`
    - `codeManagementContext.originalComment.diffHunk`

## Dataset schema (v2)

File: `datasets/memory-conversations-v2.json`

Each example:

```json
{
    "id": "string",
    "input": { "role": "user", "content": "string" },
    "contextSnippets": [
        {
            "id": "string",
            "source": "path/or/source",
            "language": "typescript|tsx|...",
            "code": "multiline code"
        }
    ],
    "shouldCreateMemory": true,
    "expected": {
        "triggerType": "explicit|implicit",
        "rule": "expected memory rule",
        "reason": "optional rationale"
    }
}
```

Constraints enforced by converter:

- exactly one `input` message and it must be `role: "user"`
- exactly one `contextSnippets` item (one file / one snippet)
- `shouldCreateMemory` must always be `true` (creation-only dataset)
- `expected.rule` is required for every case

`contextSnippets` are independent from `input` and simulate API-retrieved code context from PR review context.

## Files in this suite

- `convert-memory-quality-dataset.js` - Converts v2 dataset to promptfoo tests
- `generate-memory-quality-prompt.js` - Generates local prompt artifact from the same kodus-flow strategy/tools used by the base memory eval, then injects `contextSnippets`
- `generate-memory-quality-prompt.js` - Generates local prompt artifact from the same kodus-flow strategy/tools used by the base memory eval (no custom prompt augmentation)
- `memory-quality-prompt-loader.js` - Loads generated prompt
- `memory-quality-tool-call-assertion.js` - Deterministic checks
- `memory-quality-llm-judge-assertion.js` - Semantic LLM judge
- `promptfoo.memory-quality.yaml` - Suite config
- `run-memory-quality-eval.sh` - End-to-end runner

## Run

From repo root:

```bash
yarn eval:memory:quality
```

Optional:

```bash
yarn eval:memory:quality:light
cd evals/promptfoo/memory-quality && ./run-memory-quality-eval.sh --dataset=./datasets/memory-conversations-v2.json --limit=3 --no-cache
```
