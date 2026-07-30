#!/usr/bin/env python3
"""Excalidraw: Kodus code-review harness vs competitors (positioning map + cards)."""
import json, os

elements = []
_seed = [3000]
def ns():
    _seed[0] += 1
    return _seed[0]

def base(eid, typ, x, y, w, h, fill, stroke, sw=2, style="solid", roundness=None):
    elements.append({
        "id": eid, "type": typ, "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": fill,
        "fillStyle": "solid", "strokeWidth": sw, "strokeStyle": style,
        "roughness": 0, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": roundness} if roundness else None,
        "seed": ns(), "versionNonce": ns(), "isDeleted": False,
        "boundElements": [], "updated": 1, "link": None, "locked": False,
    })

def rect(eid, x, y, w, h, fill, stroke="#1e1e1e", sw=2, style="solid", roundness=3):
    base(eid, "rectangle", x, y, w, h, fill, stroke, sw, style, roundness)

def ellipse(eid, x, y, w, h, fill, stroke="#1e1e1e", sw=2):
    base(eid, "ellipse", x, y, w, h, fill, stroke, sw)

def text_in(eid, cid, txt, fs=14, color="#1e1e1e", align="center"):
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
        "fontFamily": 2, "text": txt, "textAlign": align, "verticalAlign": "middle",
        "containerId": cid, "originalText": txt, "lineHeight": 1.25, "baseline": fs,
    })

def box(eid, x, y, w, h, txt, fill, stroke="#1e1e1e", fs=14, tcolor="#1e1e1e",
        sw=2, style="solid", align="center"):
    rect(eid, x, y, w, h, fill, stroke, sw, style)
    text_in(eid + "_t", eid, txt, fs, tcolor, align)

def dot(eid, cx, cy, label, fill, stroke="#1e1e1e", r=15, sw=2, lbl_dx=20, lbl_dy=-10,
        lbl_color=None):
    ellipse(eid, cx - r, cy - r, 2 * r, 2 * r, fill, stroke, sw)
    ftext(eid + "_l", cx + lbl_dx, cy + lbl_dy, label, 15, lbl_color or stroke, "left", 240)

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
        "containerId": None, "originalText": txt, "lineHeight": 1.3, "baseline": fs,
    })

def line(eid, x1, y1, x2, y2, color="#1e1e1e", sw=2, arrowhead="arrow"):
    elements.append({
        "id": eid, "type": "arrow", "x": x1, "y": y1, "width": x2 - x1,
        "height": y2 - y1, "angle": 0, "strokeColor": color,
        "backgroundColor": "transparent", "fillStyle": "solid", "strokeWidth": sw,
        "strokeStyle": "solid", "roughness": 0, "opacity": 100, "groupIds": [],
        "frameId": None, "roundness": None, "seed": ns(), "versionNonce": ns(),
        "isDeleted": False, "boundElements": [], "updated": 1, "link": None,
        "locked": False, "points": [[0, 0], [x2 - x1, y2 - y1]],
        "lastCommittedPoint": None, "startBinding": None, "endBinding": None,
        "startArrowhead": None, "endArrowhead": arrowhead,
    })

# ---------- colors ----------
KOD = "#ff8787"   # Kodus (highlight red)
ANT = "#ffd43b"
GRE = "#69db7c"
CUR = "#4dabf7"
CUB = "#da77f2"
COD = "#ffa94d"

ftext("title", 380, -120, "Harness de code review — Kodus vs concorrentes", 30)
ftext("sub", 380, -82,
      "eixo X: topologia do agente · eixo Y: poder de retrieval de contexto · fonte: blogs/docs (2025-26)",
      14, "#495057", w=900)

# ================= POSITIONING MAP =================
MX, MY = 80, 40           # map origin (top-left of plot box)
MW, MH = 900, 560
rect("plot", MX, MY, MW, MH, "#ffffff", stroke="#ced4da", sw=2, roundness=0)
# axes
line("xaxis", MX, MY + MH, MX + MW, MY + MH, color="#868e96", sw=2)
line("yaxis", MX, MY + MH, MX, MY, color="#868e96", sw=2)
ftext("xlbl_lo", MX + 10, MY + MH + 12, "1 loop agêntico (generalista)", 13, "#868e96", w=260)
ftext("xlbl_hi", MX + MW - 340, MY + MH + 12, "multi-agente especializado + judge →", 13, "#868e96", w=340)
ftext("ylbl_hi", MX - 70, MY - 2, "↑ grafo /\nembeddings /\nLSP", 13, "#868e96", w=120)
ftext("ylbl_lo", MX - 70, MY + MH - 60, "grep textual\n(diff + sandbox)", 13, "#868e96", w=120)

def P(fx, fy):  # fractional 0..1 -> absolute (y inverted)
    return (MX + fx * MW, MY + (1 - fy) * MH)

# points: (fx=topology, fy=context power)
px, py = P(0.12, 0.30); dot("p_kod", px, py, "Kodus  (hoje: generalist)", KOD, stroke="#e03131", r=18, sw=3, lbl_color="#e03131")
px, py = P(0.55, 0.30); dot("p_kodd", px, py, "Kodus deep (trio, off)", "#ffffff", stroke="#e03131", r=13, sw=2, lbl_color="#e03131")
line("kod_arrow", *P(0.12, 0.27), *P(0.55, 0.27), color="#e03131", sw=2)
ftext("kod_arrow_l", MX + 0.20 * MW, MY + (1 - 0.20) * MH, "capacidade latente →", 12, "#e03131", w=200)

px, py = P(0.30, 0.45); dot("p_cur", px, py, "Cursor Bugbot\n(1 loop + multi-model + learned rules)", CUR, stroke="#1971c2", r=16)
px, py = P(0.78, 0.50); dot("p_ant", px, py, "Anthropic Claude\n(fleet de agentes + verify step)", ANT, stroke="#f08c00", r=16)
px, py = P(0.70, 0.85); dot("p_gre", px, py, "Greptile\n(orchestrator+subagents, grafo+embeddings+memória)", GRE, stroke="#2f9e44", r=16)
px, py = P(0.88, 0.55); dot("p_cub", px, py, "Cubic\n(planner→micro-agentes→filtering/judge, LSP+terminal)", CUB, stroke="#9c36b5", r=16, lbl_dy=-34)
px, py = P(0.92, 0.88); dot("p_cod", px, py, "CodeRabbit\n(multi-agente + verify agent, codegraph+LanceDB+20-50 linters)", COD, stroke="#e8590c", r=16, lbl_dx=-360, lbl_dy=18)

# ================= COMPARISON CARDS =================
CY = MY + MH + 80
ftext("cards_hdr", MX, CY - 34, "Detalhe por harness  (D=documentado · ?=não documentado)", 16, "#495057", w=700)

cards = [
    ("c_kod", KOD, "Kodus (atual)",
     "Loop: 1 generalist agêntico\n"
     "Contexto: grep/readFile textual\n+ cross-file planner (E2B)\n"
     "Verify: AST + lint + LLM (conf 1-10)\n"
     "Multi-agente: trio existe, deep-only OFF\n"
     "Modelo: BYOK (qualquer)"),
    ("c_ant", ANT, "Anthropic Claude",
     "Loop: fleet de agentes paralelos\n"
     "Contexto: exploração agêntica + CLAUDE.md\n(sem embeddings D)\n"
     "Verify: 'verification step' vs comportamento real\n"
     "Multi-agente: SIM (por classe de bug)\n"
     "Modelo: Sonnet / Opus opt-in (D)"),
    ("c_gre", GRE, "Greptile",
     "Loop: orchestrator + sub-agents (Agent SDK)\n"
     "Contexto: GRAFO do repo + embeddings\n+ memória/learnings\n"
     "Verify: confidence + supressão adaptativa\n(ignorado 3x → cala; security nunca)\n"
     "Modelo: Opus 4.5 (D), cache ~90%"),
    ("c_cur", CUR, "Cursor Bugbot",
     "Loop: migrou p/ fully agêntico (1 loop)\n"
     "Contexto: pull dinâmico em runtime\n(index/embeddings ?)\n"
     "Verify: resolution-rate + learned rules\n(auto-promovidas)\n"
     "Modelo: frontier + in-house (não nomeia)"),
    ("c_cub", CUB, "Cubic",
     "Loop: planner → micro-agentes especializados\n"
     "Contexto: LSP simplificado + terminal\n(context-pulling, sandbox)\n"
     "Verify: filtering/JUDGE agent + conf 0-1\n→ -51% falso-positivo\n"
     "Modelo: router multi-provider"),
    ("c_cod", COD, "CodeRabbit",
     "Loop: híbrido pipeline + agêntico\n('curate, don't wander')\n"
     "Contexto: codegraph + LanceDB embeddings\n+ 20-50 linters / ast-grep\n"
     "Verify: verify agent gera scripts p/\n'extrair prova' do codebase\n"
     "Modelo: não nomeado (Claude de passagem)"),
]
cw, ch, gap = 290, 200, 16
for i, (eid, color, title, body) in enumerate(cards):
    cxp = MX + (i % 3) * (cw + gap)
    cyp = CY + (i // 3) * (ch + gap)
    # header strip
    box(eid + "_h", cxp, cyp, cw, 34, title, color, fs=15, sw=2)
    # body
    box(eid + "_b", cxp, cyp + 34, cw, ch - 34, body, "#ffffff",
        stroke="#ced4da", fs=11.5, align="left")

# highlight Kodus card border
kh = next(e for e in elements if e["id"] == "c_kod_h")
kh["strokeColor"] = "#e03131"; kh["strokeWidth"] = 3
kb = next(e for e in elements if e["id"] == "c_kod_b")
kb["strokeColor"] = "#e03131"; kb["strokeWidth"] = 3

# ================= TAKEAWAYS =================
TY = CY + 2 * (ch + gap) + 20
box("take", MX, TY, MW, 150,
    "Onde estamos vs onde dá pra ir:\n\n"
    "• Topologia: hoje = 1 loop generalista (perto do Cursor Bugbot atual). Trio especializado já existe no código, atrás do 'deep' mode.\n"
    "• Contexto: somos os mais 'textuais' (grep). Greptile/CodeRabbit têm grafo + embeddings; Cubic tem LSP semântico. Nosso checkTypes é só type-check.\n"
    "• Verify: temos AST+lint+LLM por confidence — mas ninguém 'extrai prova' como o verify-agent do CodeRabbit / judge do Cubic.\n"
    "• Gap recorrente do mercado que não temos: MEMÓRIA / learned-rules adaptativa (Greptile, Cursor) que suprime ruído por feedback histórico.",
    "#fff9db", stroke="#f08c00", fs=13, align="left")

out = {
    "type": "excalidraw", "version": 2, "source": "kodus-harness-comparison",
    "elements": elements,
    "appState": {"gridSize": None, "viewBackgroundColor": "#ffffff"},
    "files": {},
}
path = os.path.join(os.path.dirname(__file__), "..", "docs", "harness-comparison.excalidraw")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    json.dump(out, f, indent=2)
print("wrote", path, "elements:", len(elements))
