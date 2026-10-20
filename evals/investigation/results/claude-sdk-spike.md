# Claude Agent SDK spike (#2113, T1)

`node evals/investigation/claude-sdk-spike.js [--betas=off] [--upstream=api]`. Raw output: `claude-sdk-spike-<upstream>[-betas-off]-<date>.json`.

## 2026-10-20 · SDK 0.3.296 · darwin-arm64 · Node 22 · scripted fake server

| Question | Answer | Consequence for the build |
|---|---|---|
| Spawn → `system/init` | p50 151 ms, p95 175 ms (one 767 ms outlier on a cold first spawn) | One process per call is affordable for one-shot callers |
| Subprocess RSS | p50 150 MB, max 211 MB | Pool cap = worker memory budget / ~210 MB; Linux numbers come from the image run (T31) |
| Paths the CLI calls | Only `POST /v1/messages` (no `HEAD /api/hello`, no `count_tokens`) with `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | Gateway serves those two only as a fallback |
| Tools offered with `tools: []` | Only the MCP tools (`mcp__kodus__*`) | No built-in reachable |
| Default request | `thinking: adaptive`, `output_config.effort: medium`, `max_tokens: 128000`, `context_management`, `safeguards` | Executor must pass `effort` and `CLAUDE_CODE_MAX_OUTPUT_TOKENS` from the slot, or the defaults win |
| Betas on / off | On: 12 betas incl. `context-management`, `dangerous-tool-use`, `afk-mode`. With `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`: `claude-code`, `interleaved-thinking`, `mid-conversation-system`, `effort`; `context_management` and `safeguards` gone | `mid-conversation-system` stays on: third-party gateways must accept `role: "system"` inside `messages` (T34 contract) |
| `PostToolBatch.additionalContext` | Lands as a `role: "system"` message after the tool results (`messages[4]`), not inside the tool result and not as a user turn | Policy notes reach the model as system text; eval matrix covers it |
| `Stop` → `decision: "block"` | The reason is sent as a user text block plus a system message; the model gets one more request. The block **counts as a turn**: at `maxTurns: 1` the query ends `error_max_turns` with no second request | `maxTurns = maxSteps + 1` so the finalize turn fits; second Stop call has `stop_hook_active: true` |
| `PreToolUse` deny | Reason lands in that call's `tool_result`; the loop continues | Matches today's "tool not active" message path |
| `PostToolBatch` `continue: false` | Query ends before the next request, result `success` | Maps `shouldStop` directly |
| Max turns | Result `error_max_turns`, then the process exits 1 and `query()` throws `Claude Code returned an error result: Reached maximum number of turns (N)` | Executor treats "result received, then throw" as the result |
| `outputFormat: json_schema` | The CLI offers a `StructuredOutput` tool (not `output_config.format`); one request; `result.structured_output` holds the object | One-shot reads `structured_output`; fake script treats `StructuredOutput` as the done tool |
| Upstream 401 / 429 / 529 (`CLAUDE_CODE_MAX_RETRIES=0`) | Assistant message `error`: `authentication_failed` / `rate_limit` / `server_error`; result `is_error: true` with subtype `success`; process exits 1 and `query()` throws. No HTTP status on the message | Status and body come from the gateway ledger, as designed |

Still to measure with a key (`--upstream=api`): the same table against the Anthropic API, and RSS on the Linux image.

### Vertex and Bedrock envelopes (same run, CLI pointed at the fake with a `/s/<token>` path prefix)

| Mode | Env | Requests | Auth header |
|---|---|---|---|
| Anthropic | `ANTHROPIC_BASE_URL=<origin>/s/<token>` | `POST /s/<token>/v1/messages` | `x-api-key` = `ANTHROPIC_API_KEY` |
| Vertex | `CLAUDE_CODE_USE_VERTEX=1`, `ANTHROPIC_VERTEX_BASE_URL=<origin>/s/<token>/v1`, `CLAUDE_CODE_SKIP_VERTEX_AUTH=1`, project + `CLOUD_ML_REGION` | `POST /s/<token>/v1/projects/<p>/locations/<r>/publishers/anthropic/models/<m>:streamRawPredict`, then `:rawPredict` on 404 | none |
| Bedrock | `CLAUDE_CODE_USE_BEDROCK=1`, `ANTHROPIC_BEDROCK_BASE_URL=<origin>/s/<token>`, `CLAUDE_CODE_SKIP_BEDROCK_AUTH=1`, `AWS_REGION` | `GET /s/<token>/inference-profiles`, then `POST /s/<token>/model/<id>/invoke-with-response-stream`, then `/invoke` on 404 | none |

The CLI keeps the base URL's path, and with `SKIP_*_AUTH` sends no credential, so the gateway session token travels in the path (`/s/<token>`) for every format. Vertex adds the `web-search` beta; Bedrock lists inference profiles before the first call.
