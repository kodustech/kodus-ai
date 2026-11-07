# pr-risk

> - **Answers:** Does one shared PR assessment reach the configured risk model, drive routing/agents, and veto named approval policies? Do policy instructions run only after fixed conditions and reuse exact eligibility?
> - **Runs:** every engine PR through `evals/wiring-smoke.js`.
> - **Run it:** `node evals/pr-risk/run.js --model=eval-fake`
> - **Gate:** `--gate` requires all scripted contract cases to pass. No risk-quality floor has been established.
> - **Cost:** one call per enabled risk assessment; one per qualifying eligibility instruction. Exact positive/negative eligibility is reused; unavailable eligibility is retried. The scripted server has no external cost. Results record tokens and time.

Runs production's `AssessPrRiskStage`, `PrRiskAssessmentService`, `DecidePrApprovalStage` and `ApprovalPoliciesService` over complete provider snapshots, through actual integration, access, task-routing and `LLM.run` code. Stored rows and provider/billing responses enter at external boundaries. It also calls production consumers for review mode and custom-agent selection. Paired policy cases cover no-match, negative/unknown instructions, call avoidance and exact-result reuse.

The paired fixtures and scripted model check wiring, not risk judgment quality. The markers in fixture titles select scripted responses only at the simulated vendor. This runner is deliberately restricted to `eval-fake`; a measured quality evaluation requires adjudicated PR snapshots and separate approval and routing quality/cost comparisons. The historical approval corpus remains unchanged.

Compare the legacy approval assessment and the shared assessment on the identical frozen PRs with `node evals/approval-risk/run.js --model=deepseek-v4-flash@fireworks --set=full-balanced --compare-shared --output=eval-results/risk-comparison.json`. Both arms use production stages and model routing, with a clean review assumed. The shared arm records the effective review mode, per-case tokens/time and exact-result reuse. An insufficient-context or oversized-diff result stays a measured hold using the default mode; transport/model failures are reported separately. This measures risk-call cost and routing distribution, not the quality or total cost of the subsequent review. The 200 labels are preliminary AI adjudications with no human acceptance floor.
