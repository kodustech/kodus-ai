# Benchmark sets (versioned)

This folder holds the **golden comments**: the list of bugs a review is expected to find in each PR. It is the answer key every result is measured against.

Each version is a frozen folder (`v001`, `v002`, ...). Once created, **it is never edited**. If the answer key changes, create the next version.

Why: if the answer key shifts underneath us, today's number stops being comparable to yesterday's and nobody notices.

## How to use it

Every run must record which version it ran against. Without that, a score means nothing on its own.

Only compare results within the same version.

## What each folder contains

- `goldens.json` — the PRs and the expected bugs for each one
- `manifest.json` — how many PRs, how many bugs, where it came from, and what is known to be missing (`knownGaps`)

## Sets

One answer key can have different slices. Each PR declares which ones it belongs to, in its `sets` field:

- `full` — every stored PR
- `light` — the smaller slice we usually run day to day

## Versions

| version | status | PRs (full / light) | bugs (full / light) |
| ------- | ------ | ------------------ | ------------------- |
| v001    | frozen | 50 / 30 | 136 / 95 |

`v001` is the answer key exactly as it stood during the finder-recall experiments. It is out of date relative to the upstream source ([withmartian/code-review-benchmark](https://github.com/withmartian/code-review-benchmark)) — details are in `v001/manifest.json`, under `knownGaps`. It was frozen in that state on purpose, so the baseline is not lost.
