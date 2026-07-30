#!/usr/bin/env python3
"""Generate an Excalidraw diagram of the Kodus AGENT REVIEW LOOP (the harness)."""
import json, os

elements = []
_seed = [2000]
def ns():
    _seed[0] += 1
    return _seed[0]

def rect(eid, x, y, w, h, fill, stroke="#1e1e1e", roundness=3, sw=2, style="solid"):
    elements.append({
        "id": eid, "type": "rectangle", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": fill,
        "fillStyle": "solid", "strokeWidth": sw, "strokeStyle": style,
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": roundness} if roundness else None,
        "seed": ns(), "versionNonce": ns(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False,
    })

def diamond(eid, x, y, w, h, fill, stroke="#1e1e1e", sw=2):
    elements.append({
        "id": eid, "type": "diamond", "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": fill,
        "fillStyle": "solid", "strokeWidth": sw, "strokeStyle": "solid",
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": None, "seed": ns(), "versionNonce": ns(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False,
    })

def text_in(eid, cid, txt, fs=15, color="#1e1e1e"):
    cont = next(e for e in elements if e["id"] == cid)
    cont["boundElements"].append({"type": "text", "id": eid})
    elements.append({
        "id": eid, "type": "text", "x": cont["x"] + 8, "y": cont["y"] + 8,
        "width": cont["width"] - 16, "height": cont["height"] - 16, "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None, "seed": ns(),
        "versionNonce": ns(), "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False, "fontSize": fs,
        "fontFamily": 2, "text": txt, "textAlign": "center", "verticalAlign": "middle",
        "containerId": cid, "originalText": txt, "lineHeight": 1.25, "baseline": fs,
    })

def box(eid, x, y, w, h, txt, fill, stroke="#1e1e1e", fs=14, tcolor="#1e1e1e",
        roundness=3, sw=2, style="solid"):
    rect(eid, x, y, w, h, fill, stroke, roundness, sw, style)
    text_in(eid + "_t", eid, txt, fs, tcolor)

def dbox(eid, x, y, w, h, txt, fill, stroke="#1e1e1e", fs=13):
    diamond(eid, x, y, w, h, fill, stroke)
    text_in(eid + "_t", eid, txt, fs)

def ftext(eid, x, y, txt, fs=20, color="#1e1e1e", align="left", w=460):
    elements.append({
        "id": eid, "type": "text", "x": x, "y": y, "width": w,
        "height": fs * 1.25 * len(txt.split("\n")), "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": 2, "strokeStyle": "solid", "roughness": 0, "opacity": 100,
        "groupIds": [], "frameId": None, "roundness": None, "seed": ns(),
        "versionNonce": ns(), "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False, "fontSize": fs,
        "fontFamily": 2, "text": txt, "textAlign": align, "verticalAlign": "top",
        "containerId": None, "originalText": txt, "lineHeight": 1.25, "baseline": fs,
    })

def anchor(e, side):
    if side == "t": return (e["x"] + e["width"]/2, e["y"])
    if side == "b": return (e["x"] + e["width"]/2, e["y"] + e["height"])
    if side == "l": return (e["x"], e["y"] + e["height"]/2)
    if side == "r": return (e["x"] + e["width"], e["y"] + e["height"]/2)

def arrow(eid, a, sa, b, sb, color="#1e1e1e", dashed=False, sw=2, bend=None):
    ea = next(e for e in elements if e["id"] == a)
    eb = next(e for e in elements if e["id"] == b)
    sx, sy = anchor(ea, sa); tx, ty = anchor(eb, sb)
    ea["boundElements"].append({"type": "arrow", "id": eid})
    eb["boundElements"].append({"type": "arrow", "id": eid})
    if bend:  # bend is list of absolute waypoints between start and end
        pts = [[0, 0]] + [[wx - sx, wy - sy] for (wx, wy) in bend] + [[tx - sx, ty - sy]]
    else:
        pts = [[0, 0], [tx - sx, ty - sy]]
    elements.append({
        "id": eid, "type": "arrow", "x": sx, "y": sy,
        "width": tx - sx, "height": ty - sy, "angle": 0,
        "strokeColor": color, "backgroundColor": "transparent", "fillStyle": "solid",
        "strokeWidth": sw, "strokeStyle": "dashed" if dashed else "solid",
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": 2}, "seed": ns(), "versionNonce": ns(),
        "isDeleted": False, "boundElements": [], "updated": 1, "link": None,
        "locked": False, "points": pts, "lastCommittedPoint": None,
        "startBinding": {"elementId": a, "focus": 0, "gap": 4},
        "endBinding": {"elementId": b, "focus": 0, "gap": 4},
        "startArrowhead": None, "endArrowhead": "arrow",
    })

def alabel(eid, x, y, txt, color="#1e1e1e", fs=12):
    ftext(eid, x, y, txt, fs, color, "left", 200)

# palette
ORCH   = "#a5d8ff"
AGENT  = "#d0bfff"
MODEL  = "#ffec99"
TOOL   = "#b2f2bb"
DEC    = "#ffd8a8"
OUT    = "#96f2d7"
WRAP   = "#f1f3f5"
NOTE   = "#fff3bf"

ftext("title", 360, -150, "Kodus — Agent Review Harness (o loop)", 30)
ftext("sub", 360, -110, "runAgentLoop = AI SDK generateText multi-step · stopWhen [hasToolCall(submitResult) | stepCountIs(maxSteps)]", 14, "#495057", w=900)

# ============ ORCHESTRATOR FAN-OUT (top) ============
box("orch", 360, -40, 360, 64,
    "ReviewOrchestratorService\nfan-out paralelo (Promise.allSettled)", ORCH, fs=14)
# DEFAULT path: single Generalist (+ Kody Rules)
box("a_gen", 300, 70, 260, 52,
    "Generalist  ← DEFAULT (normal/fast)\nrequestedCategories = bug/sec/perf", AGENT,
    stroke="#5f3dc4", fs=12, sw=3)
box("a_kody",600, 70, 180, 52, "📏 Kody Rules\n(se houver regra ativa)", AGENT, fs=12)
arrow("o_gen", "orch", "b", "a_gen", "t", color="#1971c2", sw=3)
arrow("o_kody", "orch", "b", "a_kody", "t", color="#1971c2")
# DEEP-only trio (opt-in)
box("a_deep", 60, 70, 200, 52,
    "🐞Bug · 🔒Security · ⚡Perf\nSÓ em reviewMode='deep'", AGENT,
    stroke="#adb5bd", fs=11, style="dashed")
arrow("o_deep", "orch", "b", "a_deep", "t", color="#adb5bd", dashed=True)
alabel("orch_n", 760, -42, "default = normal → 1 Generalist\ndeep → trio (opt-in, hoje não roda)", "#1971c2", 11)

# label: one agent = one loop instance
ftext("zoom", 60, 150, "↓  cada agente = 1 instância deste loop  (hoje: o Generalist)", 15, "#6741d9", w=600)

# ============ THE LOOP (center) ============
# wrapper frame
rect("wrap", 100, 200, 760, 640, WRAP, stroke="#adb5bd", sw=2, style="dashed")
ftext("wrap_hdr", 116, 208, "runAgentLoop  —  wrappers: timeout 30min · BYOK concurrency throttle · preflight janela de contexto · coverage ledger", 12, "#868e96", w=720)

cx = 300  # left column of loop
box("prompt", cx, 250, 300, 70,
    "Build prompt\nsystem: identidade + regras + REVIEW.md\nuser: <Diffs> · callGraph · coverage · PR ctx",
    NOTE, fs=12)

box("model", cx, 360, 300, 56,
    "Model (BYOK)  ·  generateText step\nreasoning + emite tool-calls OU submitResult", MODEL, fs=13)

dbox("dec", cx + 30, 450, 240, 90, "tool-call\nou\nsubmitResult?", DEC, fs=13)

# tool execution branch (right)
box("tools", 640, 360, 320, 150,
    "Tools (RemoteCommands → sandbox E2B)\n\n"
    "grep · readFile · listDir  (core)\n"
    "checkTypes (≈LSP tipos) · readReference\n· searchDocs  (opcionais)\n\n"
    "resultado volta pro histórico de mensagens",
    TOOL, fs=12)

box("prep", 640, 540, 320, 96,
    "prepareStep (antes de cada step)\n"
    "• comprime contexto se perto da janela\n"
    "• injeta step-budget + coverage-debt\n"
    "• últimos 2 steps → force-text (sem tools, exige JSON)",
    WRAP, stroke="#868e96", fs=11)

# done branch (down)
box("parse", cx, 600, 300, 60,
    "Parse findings JSON\nfallback: modelo barato Output.object", OUT, fs=13)

box("verify", cx, 690, 300, 70,
    "Verify pass (loop curto ≤5 steps)\nfast: pula · normal: pula só conf. altíssima\ndeep: verifica tudo → derruba sem suporte",
    "#ffc9c9", fs=12)

box("findings", cx, 780, 300, 46,
    "Suggestions (confidence 1-10)", OUT, fs=13)

# arrows of the loop
arrow("l1", "prompt", "b", "model", "t")
arrow("l2", "model", "b", "dec", "t")
# tool branch: dec -> tools -> prep -> back to model
arrow("l3", "dec", "r", "tools", "l", color="#2b8a3e")
alabel("l3lbl", 575, 405, "tool-call", "#2b8a3e", 12)
arrow("l4", "tools", "b", "prep", "t", color="#2b8a3e")
arrow("l5", "prep", "l", "model", "r", color="#2b8a3e",
      bend=[(610, 588), (610, 388)])
alabel("l5lbl", 610, 470, "próximo step", "#2b8a3e", 11)
# done branch
arrow("l6", "dec", "b", "parse", "t", color="#c92a2a")
alabel("l6lbl", 200, 555, "submitResult\n(done-tool)\nou maxSteps", "#c92a2a", 11)
arrow("l7", "parse", "b", "verify", "t")
arrow("l8", "verify", "b", "findings", "t")

# stopWhen note
box("stop", 640, 250, 320, 86,
    "stopWhen\n• hasToolCall('submitResult')\n• stepCountIs(maxSteps)\n  normal 20 · deep 100 · fast capado",
    NOTE, stroke="#e8590c", fs=12, style="dashed")

# ============ back to orchestrator / merge ============
box("merge", 360, 880, 360, 56,
    "Orchestrator: coleta + dedup warnings\n→ findings de todos os agentes", ORCH, fs=13)
arrow("m1", "findings", "b", "merge", "t", color="#1971c2")

# self-contained note
box("selfc", 100, 880, 230, 56,
    "Sem sandbox/tools →\nself-contained: 1 LLM call no diff", WRAP,
    stroke="#868e96", fs=12, style="dashed")

# ============ LEGEND ============
lx, ly = 100, 980
ftext("leg_h", lx, ly - 26, "Legend", 14, "#495057")
legend = [
    ("g1", "Orchestrator", ORCH),
    ("g2", "Agente (loop)", AGENT),
    ("g3", "Model / done-tool", MODEL),
    ("g4", "Tools (sandbox)", TOOL),
    ("g5", "Decisão", DEC),
    ("g6", "Verify / output", OUT),
]
for i, (eid, label, fill) in enumerate(legend):
    box(eid, lx + (i % 3) * 200, ly + (i // 3) * 34, 190, 26, label, fill, fs=12)

out = {
    "type": "excalidraw", "version": 2, "source": "kodus-agent-loop-gen",
    "elements": elements,
    "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
    "files": {},
}
path = os.path.join(os.path.dirname(__file__), "..", "docs", "agent-review-loop.excalidraw")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(out, f, indent=2)
print("wrote", path, "elements:", len(elements))
