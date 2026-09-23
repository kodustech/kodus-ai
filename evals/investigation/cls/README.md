# #5 step 0: production-outcome classifier (issue #1821)

Question: does a classifier trained on what developers did with posted Kody suggestions
(implemented vs 👎) rank the benchmark pool better than the attributor + veracity formula?

Answer: no. Details and numbers are in the issue comment; this folder reproduces them.

## Run

Needs `bq` authenticated on `kody-408918`, `BYOK_GOOGLE_API_KEY` in `~/.kodus-dev/config`
(Gemini `gemini-embedding-001`, 768 dims), and a venv with `scikit-learn numpy`.
Production data never leaves this folder: `prod.json` and every `*.npy` are gitignored.

```bash
cd evals/investigation/cls
bq query --use_legacy_sql=false --format=json --max_rows=1000000 --quiet "$(cat export.sql)" > prod.json
python embed_prod.py full && python embed_prod.py text   # ~45 min each, 78.7k rows
python embed_pool.py                                     # 344 pool candidates
python train.py full text                                # AUC on held-out orgs (GroupKFold by org)
for m in full text; do for v in A B; do python score_pool.py $m $v 0.01; done; done
cd .. && REP_SELETOR=rep-seletor.json REP_VERACIDADE=rep-score2.json \
  REP_EXTRA="textA=cls-text-A.json,fullA=cls-full-A.json" CLS_EXTRAS=textA,fullA python3 avaliar-cls.py
```

`A` = implemented/partially vs 👎 on unimplemented; `B` = implemented/partially vs every unimplemented.
`full` embeds the comment plus existing/suggested code; `text` embeds the comment only.
`avaliar-cls.py` is `reproduzir.py`'s nested CV with configurable feature sets; the pool score
enters as a within-pool percentile, keyed by the candidate's original index.
