#!/usr/bin/env python3
"""Generate an Excalidraw diagram of the current Kodus code-review harness."""
import json, os

elements = []
_seed = [1000]
def nextseed():
    _seed[0] += 1
    return _seed[0]

def rect(eid, x, y, w, h, fill, stroke="#1e1e1e", roundness=3, sw=2, style="solid"):
    elements.append({
        "id": eid, "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": fill,
        "fillStyle": "solid", "strokeWidth": sw, "strokeStyle": style,
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": roundness} if roundness else None,
        "seed": nextseed(), "versionNonce": nextseed(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False,
    })

def text_in(eid, container_id, txt, fontsize=16, color="#1e1e1e", align="center"):
    cont = next(e for e in elements if e["id"] == container_id)
    cont["boundElements"].append({"type": "text", "id": eid})
    lines = txt.split("\n")
    elements.append({
        "id": eid, "type": "text", "x": cont["x"] + 8, "y": cont["y"] + 8,
        "width": cont["width"] - 16, "height": cont["height"] - 16, "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None, "seed": nextseed(),
        "versionNonce": nextseed(), "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False, "fontSize": fontsize,
        "fontFamily": 2, "text": txt, "textAlign": align, "verticalAlign": "middle",
        "containerId": container_id, "originalText": txt,
        "lineHeight": 1.25, "baseline": fontsize,
    })

def box(eid, x, y, w, h, txt, fill, stroke="#1e1e1e", fontsize=15, tcolor="#1e1e1e",
        roundness=3, sw=2, style="solid"):
    rect(eid, x, y, w, h, fill, stroke, roundness, sw, style)
    text_in(eid + "_t", eid, txt, fontsize, tcolor)

def free_text(eid, x, y, txt, fontsize=20, color="#1e1e1e", align="left", w=400):
    elements.append({
        "id": eid, "type": "text", "x": x, "y": y, "width": w,
        "height": fontsize * 1.25 * len(txt.split("\n")), "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None, "seed": nextseed(),
        "versionNonce": nextseed(), "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False, "fontSize": fontsize,
        "fontFamily": 2, "text": txt, "textAlign": align, "verticalAlign": "top",
        "containerId": None, "originalText": txt, "lineHeight": 1.25, "baseline": fontsize,
    })

def arrow(eid, a, b, color="#1e1e1e", style="solid", sw=2, label=None, dashed=False):
    ea = next(e for e in elements if e["id"] == a)
    eb = next(e for e in elements if e["id"] == b)
    ax, ay = ea["x"] + ea["width"]/2, ea["y"] + ea["height"]/2
    bx, by = eb["x"] + eb["width"]/2, eb["y"] + eb["height"]/2
    # decide edge anchor points
    if abs(by - ay) >= abs(bx - ax):  # vertical-ish
        if by > ay:
            sx, sy = ax, ea["y"] + ea["height"]; tx, ty = bx, eb["y"]
        else:
            sx, sy = ax, ea["y"]; tx, ty = bx, eb["y"] + eb["height"]
    else:  # horizontal-ish
        if bx > ax:
            sx, sy = ea["x"] + ea["width"], ay; tx, ty = eb["x"], by
        else:
            sx, sy = ea["x"], ay; tx, ty = eb["x"] + eb["width"], by
    ea["boundElements"].append({"type": "arrow", "id": eid})
    eb["boundElements"].append({"type": "arrow", "id": eid})
    elements.append({
        "id": eid, "type": "arrow", "x": sx, "y": sy,
        "width": tx - sx, "height": ty - sy, "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": sw, "strokeStyle": "dashed" if dashed else style,
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": 2}, "seed": nextseed(), "versionNonce": nextseed(),
        "isDeleted": False, "boundElements": [], "updated": 1, "link": None,
        "locked": False, "points": [[0, 0], [tx - sx, ty - sy]],
        "lastCommittedPoint": None,
        "startBinding": {"elementId": a, "focus": 0, "gap": 4},
        "endBinding": {"elementId": b, "focus": 0, "gap": 4},
        "startArrowhead": None, "endArrowhead": "arrow",
    })

# ---- palette
ENTRY   = "#a5d8ff"   # blue   - entry / transport
SHARED  = "#b2f2bb"   # green  - shared stages
BRANCH  = "#ffec99"   # yellow - decision
AGENT   = "#d0bfff"   # purple - agent engine
EE      = "#ffd8a8"   # orange - EE legacy engine
POST    = "#96f2d7"   # teal   - shared post
PROVIDER= "#ffc9c9"   # red    - providers
DETAIL  = "#f1f3f5"   # gray   - callouts

# ============ TITLE ============
free_text("title", 380, -120, "Kodus — Code Review Harness (atual)", 30)
free_text("subtitle", 380, -78,
          "webhook → job → pipeline (shared stages → engine branch → shared post) → posting",
          15, "#495057")

W = 300  # standard box width
CX = 540 # center column x

# ============ ENTRY CHAIN (center top) ============
box("webhook", CX, -10, W, 64,
    "Webhook\nGitHub · GitLab · Bitbucket · Azure · Forgejo", ENTRY, fontsize=14)
box("usecase", CX, 90, W, 54,
    "RunCodeReviewAutomationUseCase\n(platform → pipeline mapping)", ENTRY, fontsize=13)
box("jobproc", CX, 184, W, 54,
    "CodeReviewJobProcessorService\nrate-limit · concurrency · retry", ENTRY, fontsize=13)
box("strategy", CX, 278, W, 54,
    "CodeReviewPipelineStrategy → PipelineExecutor\nassembles + runs stage groups", ENTRY, fontsize=12)
arrow("a1", "webhook", "usecase")
arrow("a2", "usecase", "jobproc")
arrow("a3", "jobproc", "strategy")

# ============ SHARED EARLY STAGES ============
sx0 = CX - 10
early = [
    ("e_prereq", "1 · ValidatePrerequisites — license / permissions"),
    ("e_commits", "2 · ValidateNewCommits — force-push guard"),
    ("e_config", "3 · ResolveConfig — team review config"),
    ("e_engine", "4 · SelectReviewEngine ★  (branch point)"),
    ("e_vcfg",  "5 · ValidateConfig"),
    ("e_fetch", "6 · FetchChangedFiles — PR diffs"),
    ("e_ext",   "7 · LoadExternalContext — docs / refs"),
    ("e_init",  "8 · InitialComment — “review starting”"),
]
# group frame
free_text("hdr_early", sx0 + 4, 372, "SHARED EARLY STAGES", 14, "#2b8a3e")
y = 398
prev = "strategy"
for i, (eid, label) in enumerate(early):
    fill = BRANCH if eid == "e_engine" else SHARED
    box(eid, sx0, y, W + 20, 40, label, fill, fontsize=12)
    arrow(f"ea{i}", prev, eid)
    prev = eid
    y += 50

# ============ BRANCH FORK ============
fork_y = y + 20
free_text("forklbl", sx0 + 30, fork_y - 14, "engine?", 13, "#e8590c")

# ----- AGENT BRANCH (left, default) -----
agx = 60
free_text("hdr_agent", agx, fork_y + 16, "AGENT ENGINE  (default / v4)", 14, "#6741d9")
agent_stages = [
    ("ag_bl", "9 · BusinessLogicValidation\nticket / requirement check"),
    ("ag_sb", "10 · CreateSandbox (E2B)\nclone · lease-managed"),
    ("ag_rev","11 · AgentReview\nReviewOrchestratorService (parallel fan-out)"),
]
ay2 = fork_y + 46
prev = "e_init"
first_agent = True
for i, (eid, label) in enumerate(agent_stages):
    box(eid, agx, ay2, W + 20, 56, label, AGENT, fontsize=12)
    if first_agent:
        arrow("fork_agent", "e_init", eid, color="#6741d9", label="default")
        first_agent = False
    else:
        arrow(f"aga{i}", prev, eid, color="#6741d9")
    prev = eid
    ay2 += 78

# 3 agents callout
box("agents", agx - 10, ay2 + 6, W + 40, 120,
    "3 specialized agents (+ Kody Rules)\n\n"
    "🐞 Bug — logic, edge cases, races, nulls\n"
    "🔒 Security — authz, injection, secrets\n"
    "⚡ Performance — N+1, leaks, hot paths\n"
    "📏 Kody Rules — custom org rules",
    DETAIL, stroke="#6741d9", fontsize=12, style="dashed")
arrow("ag_to_agents", "ag_rev", "agents", color="#6741d9", dashed=True)

# ----- EE BRANCH (right, legacy) -----
eex = 980
free_text("hdr_ee", eex, fork_y + 16, "EE ENGINE  (legacy / opt-in)", 14, "#e8590c")
ee_stages = [
    ("ee_gate", "9 · FileContextGate\nneed cross-file context?"),
    ("ee_ctx",  "10 · CollectCrossFileContext\nE2B sandbox search"),
    ("ee_ft",   "11 · KodyFineTuning\nrule clustering"),
    ("ee_pr",   "12 · ProcessFilesPrLevelReview"),
    ("ee_file", "13 · ProcessFilesReview (file-level)"),
]
ey2 = fork_y + 46
prev = "e_init"
first_ee = True
for i, (eid, label) in enumerate(ee_stages):
    box(eid, eex, ey2, W + 20, 56, label, EE, fontsize=12)
    if first_ee:
        arrow("fork_ee", "e_init", eid, color="#e8590c", dashed=True, label="opt-in")
        first_ee = False
    else:
        arrow(f"eea{i}", prev, eid, color="#e8590c")
    prev = eid
    ey2 += 78

# cross-file callout
box("xfile", eex - 10, ey2 + 6, W + 40, 110,
    "Cross-file context flow\n\n"
    "Planner (LLM queries)\n→ Search (grep in sandbox, parallel)\n"
    "→ Dedup → Sufficiency loop\n→ Hop expand (bounded ≤60 snippets)",
    DETAIL, stroke="#e8590c", fontsize=12, style="dashed")
arrow("ee_to_xfile", "ee_ctx", "xfile", color="#e8590c", dashed=True)

# ============ SHARED POST STAGES (center, below branches) ============
converge_y = max(ay2 + 140, ey2 + 130)
free_text("hdr_post", sx0 + 4, converge_y - 26, "SHARED POST STAGES", 14, "#0c8599")
post = [
    ("p_prc",  "CreatePrLevelComments"),
    ("p_val",  "ValidateSuggestions — AST + sandbox lint + LLM validator"),
    ("p_fc",   "CreateFileComments — snap lines to diff"),
    ("p_agg",  "AggregateResults"),
    ("p_sum",  "UpdateComments & GenerateSummary"),
    ("p_fin",  "RequestChanges / Approve  + notify"),
]
py = converge_y
prev = None
for i, (eid, label) in enumerate(post):
    box(eid, sx0, py, W + 20, 42, label, POST, fontsize=12)
    if prev:
        arrow(f"pa{i}", prev, eid, color="#0c8599")
    prev = eid
    py += 52
# converge arrows from both branches into first post stage
arrow("cv_agent", "agents", "p_prc", color="#6741d9")
arrow("cv_ee", "xfile", "p_prc", color="#e8590c")

# ============ PROVIDERS (bottom) ============
box("providers", sx0, py + 24, W + 20, 60,
    "Post comments back to PR/MR\nGitHub · GitLab · Bitbucket · Azure · Forgejo",
    PROVIDER, fontsize=13)
arrow("to_prov", "p_fin", "providers", color="#c92a2a")

# ============ LEGEND ============
lx, ly = 60, converge_y + 40
free_text("leg_hdr", lx, ly - 26, "Legend", 14, "#495057")
legend = [
    ("lg1", "Entry / transport", ENTRY),
    ("lg2", "Shared stages", SHARED),
    ("lg3", "Branch point", BRANCH),
    ("lg4", "Agent engine", AGENT),
    ("lg5", "EE legacy engine", EE),
    ("lg6", "Shared post", POST),
    ("lg7", "Git providers", PROVIDER),
]
for i, (eid, label, fill) in enumerate(legend):
    box(eid, lx, ly + i * 34, 220, 26, label, fill, fontsize=12)

out = {
    "type": "excalidraw", "version": 2, "source": "kodus-harness-gen",
    "elements": elements,
    "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
    "files": {},
}
path = os.path.join(os.path.dirname(__file__), "..", "docs", "code-review-harness.excalidraw")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(out, f, indent=2)
print("wrote", path, "elements:", len(elements))
