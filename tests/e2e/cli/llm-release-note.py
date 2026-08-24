#!/usr/bin/env python3
"""LLM read of the aggregated E2E evidence — interpretation, not numbers.

The deterministic scoreboard (render-scoreboard.py) states WHAT happened;
this asks a cheap LLM for the "so what": classify each failure
(infra/quota vs test-side vs product), flag what should block a promote
approval vs what is noise, and say it in a few lines for Discord and the
run summary. Numbers always come from the scoreboard — the note is
explicitly labeled as automated analysis and must never be the source of
truth for counts.

Advisory by design: no API key configured, request failure, or garbage
response → prints a notice and exits 0. Visibility must not gate.

Env (same trio the matrix cells use for the product LLM — one vendor,
one key, one variable to debug):
  E2E_LLM_API_KEY   required to do anything (skips silently when absent)
  E2E_LLM_BASE_URL  OpenAI-compatible base
                    (default https://api.fireworks.ai/inference/v1)
  E2E_LLM_MODEL     model id
                    (default accounts/fireworks/models/deepseek-v4-flash-0731)

Usage: llm-release-note.py [evidence-dir]
"""

import glob
import json
import os
import re
import sys
import urllib.request

TIMEOUT_S = 60
MAX_ERROR_CHARS = 400

SYSTEM_PROMPT = """You are a release engineer reviewing E2E matrix evidence for a code-review product.
The gate already decided pass/fail — your job is interpretation of what the green hid.

For the failures and coverage gaps you receive, answer in AT MOST 5 short markdown bullet lines, English:
1. Classify each distinct failure: [infra/quota] (external service limits, network), [test-side] (fixture, harness, test env setup) or [product] (the application itself misbehaved). When unsure, say so.
2. Say which items deserve action before approving a promote, and which are noise.
3. Flag coverage gaps worth fixing (planned scenarios that did not run).

Rules: do NOT restate totals or counts (the scoreboard already shows them); do not invent facts beyond the evidence given; no preamble, bullets only."""


def load_json(path):
    try:
        with open(path) as fh:
            return json.load(fh)
    except Exception:
        return None


def one_line(text, limit=MAX_ERROR_CHARS):
    flat = re.sub(r"\s+", " ", str(text or "")).strip()
    return flat[:limit] + ("…" if len(flat) > limit else "")


def collect_facts(evidence_dir):
    facts = {"cells": []}
    for path in sorted(
        glob.glob(os.path.join(evidence_dir, "**", "notify.json"), recursive=True)
    ):
        notify = load_json(path) or {}
        result = load_json(os.path.join(os.path.dirname(path), "result.json")) or {}
        rows = result.get("results", [])
        cell = next(
            (r.get("cell") for r in rows if (r.get("cell") or {}).get("provider")),
            {},
        )
        facts["cells"].append({
            "cell": "{} × {}".format(cell.get("provider", "?"), cell.get("license", "?")),
            "verdict": notify.get("verdict"),
            "advisory_failures": [
                {"priority": f.get("priority"), "scenario": f.get("cell"),
                 "error": one_line(f.get("error"))}
                for f in notify.get("advisoryFailures", [])
            ],
            "gating_failures": [
                {"scenario": f.get("cell"), "error": one_line(f.get("error"))}
                for f in notify.get("gatingFailures", [])
            ],
            "setup_skips": [
                {"scenario": r.get("scenarioId"),
                 "reason": one_line((r.get("evidence") or {}).get("skipReason"))}
                for r in rows
                if r.get("status") == "skipped" and r.get("skipKind") == "setup"
            ],
            "flaky": notify.get("retriedCells", []),
        })
    return facts


def call_llm(base_url, api_key, model, facts):
    body = json.dumps({
        "model": model,
        "temperature": 0.2,
        # Thinking-by-default models (DeepSeek V4 Flash on Fireworks) burn
        # tokens on reasoning_content BEFORE the visible answer; a tight cap
        # returns finish_reason=length with empty content. Leave headroom.
        "max_tokens": 2500,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps(facts, ensure_ascii=False)},
        ],
    }).encode()
    req = urllib.request.Request(
        base_url.rstrip("/") + "/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + api_key,
        },
    )
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as resp:
        data = json.load(resp)
    # CI tooling can't route through the product's runAiSdkLLMInSpan
    # accounting (no NestJS runtime, no org context here) — log the
    # provider-reported usage instead so consumption stays visible.
    usage = data.get("usage") or {}
    print("LLM usage: prompt={} completion={} total={}".format(
        usage.get("prompt_tokens", "?"), usage.get("completion_tokens", "?"),
        usage.get("total_tokens", "?")))
    return (data.get("choices") or [{}])[0].get("message", {}).get("content", "").strip()


def main():
    evidence_dir = sys.argv[1] if len(sys.argv) > 1 else "evidence"
    api_key = os.environ.get("E2E_LLM_API_KEY", "").strip()
    if not api_key:
        print("E2E_LLM_API_KEY not configured — skipping LLM release note.")
        return
    base_url = os.environ.get(
        "E2E_LLM_BASE_URL", "https://api.fireworks.ai/inference/v1"
    ).strip()
    model = os.environ.get(
        "E2E_LLM_MODEL", "accounts/fireworks/models/deepseek-v4-flash-0731"
    ).strip()

    facts = collect_facts(evidence_dir)
    if not facts["cells"]:
        print("No evidence found — skipping LLM release note.")
        return
    nothing_to_read = all(
        not c["advisory_failures"] and not c["gating_failures"]
        and not c["setup_skips"] and not c["flaky"]
        for c in facts["cells"]
    )
    if nothing_to_read:
        print("All clear — nothing for the LLM to interpret.")
        return

    try:
        note = call_llm(base_url, api_key, model, facts)
    except Exception as exc:  # advisory: never fail the job over a nicety
        print("::warning title=LLM release note failed (advisory)::{}".format(
            one_line(exc, 200)))
        return
    if not note:
        print("::warning title=LLM release note failed (advisory)::empty response")
        return

    header = "### 🤖 Automated read ({}) — analysis, not source of truth\n".format(
        model.rsplit("/", 1)[-1])
    step_summary = os.environ.get("GITHUB_STEP_SUMMARY")
    if step_summary:
        with open(step_summary, "a") as fh:
            fh.write("\n" + header + "\n" + note + "\n")
    else:
        print(header + "\n" + note)

    gh_output = os.environ.get("GITHUB_OUTPUT")
    if gh_output:
        with open(gh_output, "a") as fh:
            fh.write("llm_note<<__E2E_LLM_NOTE__\n{}\n__E2E_LLM_NOTE__\n".format(note))


if __name__ == "__main__":
    main()
