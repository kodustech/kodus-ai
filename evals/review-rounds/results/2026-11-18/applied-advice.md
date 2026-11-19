# Following up on applied advice in PR 2597

The prior PR head was 45e29fa6e. The candidate ran at d0dc9c813 with the verifier change committed as eb07f8561. DeepSeek V4.1 Flash on Fireworks, BYOK reasoning off, GPT-OSS-120B judge at low reasoning. All reviews measured.

The general set improved from 49/58 to 53/58 correct delivery decisions. Of four consequences that should be delivered and linked, the prior head handled one and the candidate handled three. Reproduce the breakdown with `node evals/review-rounds/compare-quality.js evals/review-rounds/results/2026-11-18/{pr,applied-advice-pr}.json` in bash or zsh.

The focused set uses four reviews per case. Both engines handled 29/32 decisions correctly.

| Case | Prior PR | Candidate |
| --- | ---: | ---: |
| R1-repeat-open | 4/4 | 4/4 |
| R12-unrelated-other-file | 4/4 | 4/4 |
| R13-repeat-after-move | 4/4 | 4/4 |
| R18-offline-inventory-consequence | 4/4 | 4/4 |
| R19-offline-inventory-safe | 4/4 | 4/4 |
| R2-consequence-status-implemented | 4/4 | 3/4 |
| R7-refines-prior | 3/4 | 2/4 |
| R8-consequence-kody-rule-prior | 2/4 | 4/4 |

An additional eight R7 reviews per engine suppressed 6/8 repeats on the prior PR and 7/8 on the candidate. Combined with the four above, both engines suppressed 9/12. R7 is an incomplete attempt to fix an earlier report.

Run `evals/review-rounds/run.js` with `--set=applied-advice --reps=4` for the focused set and `--case=R7 --reps=8` for the additional check. The same serialized cases were supplied to both engines. These are repeated decisions on labeled examples from one model.
