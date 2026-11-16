"""Lay out the two README diagrams once; write SVGs (en, ko) and Claude Design canvas sources. Run: python3 docs/images/diagrams.py docs/images"""
import html
import json
import sys
from pathlib import Path

OUT = Path(sys.argv[1])
CARD_W, CARD_H = 200, 96
COLS = [64, 336, 608, 880, 1152]
ROWS = [160, 336, 512, 688]
WIDTH = 1416
LINE = 20
FONT = 15
LABEL = 12

INK, MUTED, LINE_C, CARD_BG, BORDER = "#1f2328", "#59636e", "#8c959f", "#ffffff", "#d0d7de"
ACCENT, ACCENT_BG = "#2f6beb", "#eaf1fe"
GROUND = "#f6f8fa"


def card(key, col, row, en, ko, style="plain", w=CARD_W):
    return {"key": key, "x": COLS[col], "y": ROWS[row], "w": w, "h": CARD_H, "en": en, "ko": ko, "style": style}


def cx(c):
    return c["x"] + c["w"] // 2


def cy(c):
    return c["y"] + c["h"] // 2


# An arrow is a list of straight segments [(x1,y1,x2,y2)], head on the last; label = (en, ko, x, y) or None.
def seg_h(x1, x2, y):
    return (x1, y, x2, y)


def seg_v(x, y1, y2):
    return (x, y1, x, y2)


def right_to_left(a, b, y):  # from a's right edge to b's left edge (b right of a)
    return [seg_h(a["x"] + a["w"], b["x"] - 1, y)]


def left_to_right_back(a, b, y):  # from b's left edge back to a's right edge (pointing left)
    return [seg_h(b["x"], a["x"] + a["w"] + 1, y)]


def down(a, b, x):
    return [seg_v(x, a["y"] + a["h"], b["y"] - 1)]


def up(a, b, x):  # from b's top edge up to a's bottom edge (a above b)
    return [seg_v(x, b["y"], a["y"] + a["h"] + 1)]


def diagram_usage():
    owner = card("owner", 0, 0, ["Owner", "asks in Telegram"], ["대표", "텔레그램으로 요청"])
    pm = card("pm", 1, 0, ["PM bot · Hermes", "files tickets; woken", "when a worker ends"], ["한결 · Hermes PM 봇", "티켓 만들기, 작업자가", "끝나면 깨어나 보고"])
    notion = card("notion", 2, 0, ["Notion ticket DB", "assigned to", "Claude Code"], ["Notion 티켓 DB", "담당 = Claude Code"])
    board = card("board", 3, 0, ["notion_board.py", "command-board script", "Notion ↔ nightshift"], ["notion_board.py", "command 보드 스크립트", "Notion ↔ nightshift"])
    cron = card("cron", 1, 1, ["Hermes cron", "every 15 minutes"], ["Hermes cron", "15분마다"])
    entry = card("entry", 2, 1, ["claude_dev_runner.sh", "entry point; switch", "nightshift.enabled"], ["claude_dev_runner.sh", "진입점 · 스위치 파일", "nightshift.enabled"])
    ns = card("ns", 3, 1, ["nightshift", "dispatch; one worker", "per project (max 5)"], ["nightshift", "배차, 프로젝트당", "작업자 1명 (최대 5)"], "accent")
    legacy = card("legacy", 2, 2, ["legacy bash runner", "only when the switch", "file is gone"], ["이전 bash 러너", "스위치 파일이", "없을 때만"], "dashed")
    builder = card("builder", 3, 2, ["Claude Code · sonnet", "builds in its own", "worktree, opens a PR"], ["Claude Code · sonnet", "자기 worktree에서", "개발, PR 열기"])
    reviewer = card("reviewer", 4, 2, ["Claude Code · opus", "reviews as CTO,", "fixes small things"], ["Claude Code · opus", "CTO로 검토,", "작은 건 직접 고침"])
    pr = card("pr", 4, 3, ["GitHub pull request", "merged by nightshift", "after PASS"], ["GitHub PR", "PASS면 nightshift가", "머지"])
    post = card("post", 3, 3, ["post_merge.sh", "QA smoke on emulator,", "figdex release call"], ["post_merge.sh", "에뮬레이터 QA 스모크,", "figdex 출시 판단"])
    cards = [owner, pm, notion, board, cron, entry, ns, legacy, builder, reviewer, pr, post]
    t1, t2 = 32, 64  # thirds of a 96px-high edge
    v1, v2 = 67, 133  # thirds of a 200px-wide edge
    arrows = [
        ("owner→pm", right_to_left(owner, pm, owner["y"] + t1), ("asks", "요청", "above"), False, "From the owner to the PM bot: asks for work"),
        ("pm→owner", left_to_right_back(owner, pm, owner["y"] + t2), ("reports", "보고", "below"), False, "From the PM bot back to the owner: reports"),
        ("pm→notion", right_to_left(pm, notion, cy(pm)), ("files", "티켓", "above"), False, "From the PM bot to the Notion ticket DB: files a ticket"),
        ("board→notion", left_to_right_back(notion, board, notion["y"] + t1), ("writes", "쓰기", "above"), False, "From the board script to Notion: writes status and notes"),
        ("notion→board", right_to_left(notion, board, notion["y"] + t2), ("reads", "읽기", "below"), False, "From Notion to the board script: reads tickets"),
        ("notion→entry", down(notion, entry, cx(notion)), ("hook", "훅", "beside"), False, "From the Notion ticket DB to the entry point: a ticket set ready starts it"),
        ("cron→entry", right_to_left(cron, entry, cy(cron)), ("timer", "타이머", "above"), False, "From Hermes cron to the entry point: every 15 minutes"),
        ("entry→ns", right_to_left(entry, ns, cy(entry)), ("run", "run", "above"), False, "From the entry point to nightshift: run"),
        ("entry→legacy", down(entry, legacy, cx(entry)), ("switch off", "스위치 끔", "beside"), True, "From the entry point to the legacy bash runner, only when the switch is off"),
        ("ns→board", up(board, ns, ns["x"] + v1), ("calls", "호출", "beside-left"), False, "From nightshift to the board script: list, set-status, note"),
        ("board→ns", down(board, ns, ns["x"] + v2), ("tickets", "티켓", "beside"), False, "From the board script to nightshift: tickets"),
        ("ns→builder", down(ns, builder, cx(ns)), ("starts", "시작", "beside"), False, "From nightshift to the builder: starts a run per ticket"),
        ("builder→reviewer", right_to_left(builder, reviewer, builder["y"] + t1), ("result", "결과", "above"), False, "From the builder to the reviewer: the result file"),
        ("reviewer→builder", left_to_right_back(builder, reviewer, builder["y"] + t2), ("REWORK", "재작업", "below"), False, "From the reviewer back to the builder: rework"),
        ("reviewer→pr", down(reviewer, pr, cx(reviewer)), ("PASS", "PASS", "beside"), False, "From the reviewer to the pull request: PASS, nightshift merges"),
        ("pr→post", left_to_right_back(post, pr, cy(pr)), ("merged", "머지 뒤", "above"), False, "From the merged pull request to the post-merge hook"),
    ]
    title = ("How we run nightshift at catchmeif404", "catchmeif404에서 nightshift를 쓰는 방식")
    return title, cards, arrows, ROWS[3] + CARD_H + 64, None


def diagram_internals():
    b = card("board", 0, 0, ["Board", "local-md · GitHub ·", "Notion · command"], ["보드", "local-md · GitHub ·", "Notion · command"])
    d = card("dispatch", 1, 0, ["Dispatch", "run or daemon;", "one lock at a time"], ["배차", "run 또는 daemon,", "잠금은 하나"])
    s = card("slots", 2, 0, ["Slots", "one worker per project;", "release tickets alone"], ["슬롯", "프로젝트당 작업자 1명,", "출시 티켓은 혼자"])
    w = card("worker", 3, 0, ["Worker", "cut-off tickets first,", "then ready ones"], ["작업자", "끊긴 티켓 먼저,", "그다음 할 일"])
    wt = card("worktree", 4, 0, ["Worktree", "own branch per ticket;", "your checkout untouched"], ["worktree", "티켓마다 자기 브랜치,", "내 체크아웃은 그대로"])
    build = card("build", 4, 1, ["Build", "result: PR, BRANCH,", "DOC or BLOCKED"], ["개발", "결과: PR, BRANCH,", "DOC 또는 BLOCKED"])
    review = card("review", 3, 1, ["Review", "PASS, REWORK,", "NEEDS_HUMAN, BLOCKED"], ["검토", "PASS, REWORK,", "NEEDS_HUMAN, BLOCKED"])
    settle = card("settle", 2, 1, ["Settle", "moves the ticket: review,", "blocked or done"], ["정리", "티켓 옮기기: review,", "blocked, done"], "accent")
    merge = card("merge", 2, 2, ["Merge", "with autoMerge on,", "then post-merge command"], ["머지", "autoMerge 일 때,", "그다음 머지 뒤 명령"])
    agents = card("agents", 3, 2, ["Coding agents", "Claude Code (default) · Codex · any CLI", "fixed session per stage, resumed after a cut-off"], ["코딩 에이전트", "Claude Code (기본) · Codex · 아무 CLI", "단계마다 세션 고정, 끊기면 이어 가기"], "plain", w=COLS[4] + CARD_W - COLS[3])
    cards = [b, d, s, w, wt, build, review, settle, merge, agents]
    t1, t2 = 32, 64
    left_x = cx(b)
    arrows = [
        ("b→d", right_to_left(b, d, cy(b)), ("tickets", "티켓", "above"), False, "From the board to dispatch: ready and cut-off tickets"),
        ("d→s", right_to_left(d, s, cy(d)), ("start", "시작", "above"), False, "From dispatch to the slots: starts workers"),
        ("s→w", right_to_left(s, w, cy(s)), None, False, "From a slot to its worker"),
        ("w→wt", right_to_left(w, wt, cy(w)), None, False, "From the worker to the ticket's worktree"),
        ("wt→build", down(wt, build, cx(wt)), None, False, "From the worktree to the build stage"),
        ("build→review", left_to_right_back(review, build, build["y"] + t1), ("result", "결과", "above"), False, "From build to review: the result file"),
        ("review→build", right_to_left(review, build, build["y"] + t2), ("REWORK", "재작업", "below"), False, "From review back to build: rework with the review notes"),
        ("review→settle", left_to_right_back(settle, review, cy(review)), ("verdict", "판정", "above"), False, "From review to settle: the verdict"),
        ("settle→merge", down(settle, merge, cx(settle)), ("PASS", "PASS", "beside"), False, "From settle to merge, when the review passed"),
        ("build→agents", down(build, agents, cx(build)), ("developer", "개발 실행", "beside"), False, "From the build stage to the coding agent: a developer run"),
        ("review→agents", down(review, agents, cx(review)), ("reviewer", "검토 실행", "beside"), False, "From the review stage to the coding agent: a reviewer run"),
        ("settle→board", [seg_h(settle["x"], left_x, cy(settle)), seg_v(left_x, cy(settle), b["y"] + b["h"] + 1)], ("status + reason + note", "상태 + 사유 + 메모", "above-long"), False, "From settle back to the board: status, reason and note"),
    ]
    caption = (
        "Every stage must leave a one-line result file; anything else is set aside and the stage runs again. State lives in .nightshift/: stage, session, tries, results, log.",
        "모든 단계는 한 줄짜리 결과 파일을 남겨야 끝난 것으로 칩니다. 못 읽으면 치워 두고 그 단계를 다시 돌립니다. 상태는 .nightshift/ 에: 단계, 세션, 시도 횟수, 결과, 로그.",
    )
    title = ("Inside nightshift", "nightshift 내부 구조")
    return title, cards, arrows, ROWS[2] + CARD_H + 128, caption


def label_box(seg, text, where, chars_w):
    x1, y1, x2, y2 = seg
    w = max(24, int(len(text) * chars_w) + 8)
    if where in ("above", "below", "above-long"):
        mid = (min(x1, x2) + max(x1, x2)) / 2
        top = y1 - 28 if where.startswith("above") else y1 + 12
        return int(mid - w / 2), top, w
    if where == "beside-left":
        return x1 - 12 - w, (min(y1, y2) + max(y1, y2)) // 2 - 8, w
    return x1 + 12, (min(y1, y2) + max(y1, y2)) // 2 - 8, w


def segment_geom(seg, head):
    x1, y1, x2, y2 = seg
    h = 4 if head else 0
    if y1 == y2:  # horizontal
        left, n = min(x1, x2), abs(x2 - x1)
        path = f"M 0 4 L {n - h} 4" if x2 > x1 else f"M {n} 4 L {h} 4"
        return left, y1 - 4, n, 8, path
    top, n = min(y1, y2), abs(y2 - y1)
    path = f"M 4 0 L 4 {n - h}" if y2 > y1 else f"M 4 {n} L 4 {h}"
    return x1 - 4, top, 8, n, path


def svg_doc(lang, title, cards, arrows, height, caption):
    font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Apple SD Gothic Neo', 'Noto Sans KR', Helvetica, Arial, sans-serif"
    chars_w = 7.2 if lang == "en" else 12.5
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" width="{WIDTH}" height="{height}" viewBox="0 0 {WIDTH} {height}" role="img" aria-label="{html.escape(title[0 if lang == "en" else 1])}">',
           "<style>",
           f".bg{{fill:{GROUND}}} .card{{fill:{CARD_BG};stroke:{BORDER}}} .accent{{fill:{ACCENT_BG};stroke:{ACCENT};stroke-width:1.5}} .dashed{{fill:{CARD_BG};stroke:{LINE_C};stroke-dasharray:6 5}}",
           f".t{{font-family:{font};fill:{INK}}} .m{{fill:{MUTED}}} .ln{{stroke:{LINE_C};stroke-width:2;fill:none;stroke-linecap:round}} .hd{{fill:{LINE_C}}} .lb{{font-family:{font};font-size:{LABEL}px;fill:{MUTED}}}",
           "@media (prefers-color-scheme: dark){.bg{fill:#0d1117} .card,.dashed{fill:#161b22;stroke:#3d444d} .accent{fill:#0f2a5c;stroke:#4c8dff} .t{fill:#e6edf3} .m,.lb{fill:#9198a1} .ln{stroke:#6e7681} .hd{fill:#6e7681}}",
           "</style>",
           '<defs><marker id="h" orient="auto" markerWidth="5" markerHeight="5" refX="2" refY="2" overflow="visible"><path class="hd" d="M0 0 L4 2 L0 4 Z"/></marker></defs>',
           f'<rect class="bg" x="0" y="0" width="{WIDTH}" height="{height}" rx="12"/>',
           f'<text class="t" x="64" y="96" font-size="24" font-weight="600">{html.escape(title[0 if lang == "en" else 1])}</text>']
    for _key, segs, label, dashed, _aria in arrows:
        for i, seg in enumerate(segs):
            x1, y1, x2, y2 = seg
            head = i == len(segs) - 1
            # shorten the tip by 4 (2 stroke widths) so the head ends at the tip
            if head:
                if y1 == y2:
                    x2 = x2 - 4 if x2 > x1 else x2 + 4
                else:
                    y2 = y2 - 4 if y2 > y1 else y2 + 4
            dash = ' stroke-dasharray="6 6"' if dashed else ""
            mk = ' marker-end="url(#h)"' if head else ""
            out.append(f'<path class="ln" d="M {x1} {y1} L {x2} {y2}"{dash}{mk}/>')
        if label:
            text = label[0 if lang == "en" else 1]
            seg = segs[0] if label[2] == "above-long" else segs[-1]
            lx, ly, lw = label_box(seg, text, label[2], chars_w)
            anchor_x = lx + lw / 2 if label[2] in ("above", "below", "above-long") else (lx + lw if label[2] == "beside-left" else lx)
            anchor = "middle" if label[2] in ("above", "below", "above-long") else ("end" if label[2] == "beside-left" else "start")
            out.append(f'<text class="lb" x="{anchor_x:.0f}" y="{ly + 12}" text-anchor="{anchor}">{html.escape(text)}</text>')
    for c in cards:
        cls = {"plain": "card", "accent": "accent", "dashed": "dashed"}[c["style"]]
        out.append(f'<rect class="{cls}" x="{c["x"] + 0.5}" y="{c["y"] + 0.5}" width="{c["w"] - 1}" height="{c["h"] - 1}" rx="10"/>')
        lines = c[lang]
        top = c["y"] + c["h"] / 2 - (len(lines) * LINE) / 2 + 15
        for i, line in enumerate(lines):
            weight = ' font-weight="600"' if i == 0 else ""
            cls2 = "t" if i == 0 else "t m"
            size = FONT if i == 0 else FONT - 1
            out.append(f'<text class="{cls2}" x="{c["x"] + c["w"] / 2:.0f}" y="{top + i * LINE:.0f}" font-size="{size}" text-anchor="middle"{weight}>{html.escape(line)}</text>')
    if caption:
        text = caption[0 if lang == "en" else 1]
        out.append(f'<text class="lb" x="64" y="{height - 56}" font-size="13">{html.escape(text)}</text>')
    out.append("</svg>")
    return "\n".join(out) + "\n"


def dc_doc(name, title, cards, arrows, height, caption):
    lines = []
    arrow_no = 1
    for _key, segs, label, dashed, aria in arrows:
        for i, seg in enumerate(segs):
            head = i == len(segs) - 1
            left, top, w, h, path = segment_geom(seg, head)
            dash = "; stroke-dasharray: 6 6" if dashed else ""
            if head:
                mid = f"dc-arrow-head-filled-{arrow_no}"
                arrow_no += 1
                defs = (f'<defs><marker id="{mid}" orient="auto" markerWidth="5" markerHeight="5" refX="2" refY="2" overflow="visible">'
                        f'<path d="M0 0 L4 2 L0 4 Z" fill="{LINE_C}" stroke="none" style="stroke: none; fill: {LINE_C}; fill: context-stroke"/></marker></defs>')
                body = f'<path d="{path}" marker-end="url(#{mid})"></path>'
                a11y = f'role="img" aria-label="{html.escape(aria)}"'
            else:
                defs, body, a11y = "", f'<path d="{path}"></path>', 'aria-hidden="true"'
            lines.append(f'<svg {a11y} width="{w}" height="{h}" viewBox="0 0 {w} {h}" preserveAspectRatio="none" style="position: absolute; left: {left}px; top: {top}px; width: {w}px; height: {h}px; overflow: visible; fill: none; stroke: {LINE_C}; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round{dash}">{defs}{body}</svg>')
    lines.append(f'<div style="position: absolute; left: 64px; top: 72px; font-size: 24px; line-height: 32px; font-weight: 600; color: {INK}">{html.escape(title[0])}</div>')
    for c in cards:
        bg, border = {"plain": (CARD_BG, f"1px solid {BORDER}"), "accent": (ACCENT_BG, f"1.5px solid {ACCENT}"), "dashed": (CARD_BG, f"1px dashed {LINE_C}")}[c["style"]]
        first, rest = c["en"][0], c["en"][1:]
        label = f'<b style="color: {INK}">{html.escape(first)}</b><br>' + "<br>".join(html.escape(r) for r in rest)
        lines.append(f'<div style="position: absolute; left: {c["x"]}px; top: {c["y"]}px; width: {c["w"]}px; height: {c["h"]}px; box-sizing: border-box; padding: 8px 12px; display: flex; align-items: center; justify-content: center; text-align: center; font-size: 14px; line-height: 20px; color: {MUTED}; background: {bg}; border: {border}; border-radius: 10px"><span>{label}</span></div>')
    for _key, segs, label, _dashed, _aria in arrows:
        if not label:
            continue
        seg = segs[0] if label[2] == "above-long" else segs[-1]
        lx, ly, lw = label_box(seg, label[0], label[2], 7.2)
        align = "center" if label[2] in ("above", "below", "above-long") else ("right" if label[2] == "beside-left" else "left")
        lines.append(f'<div style="position: absolute; left: {lx}px; top: {ly}px; width: {lw}px; text-align: {align}; font-size: 12px; line-height: 16px; color: {MUTED}">{html.escape(label[0])}</div>')
    if caption:
        lines.append(f'<div style="position: absolute; left: 64px; top: {height - 72}px; width: {WIDTH - 128}px; font-size: 13px; line-height: 18px; color: {MUTED}">{html.escape(caption[0])}</div>')
    host = "\n".join(lines)
    props = json.dumps({"$preview": {"width": WIDTH, "height": height}})
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{html.escape(title[0])}</title>
<script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
<style>
body{{margin:0}}
a{{color:{ACCENT}}}a:hover{{color:#1d4fc4}}
</style>
</helmet>
<div style="position: relative; width: {WIDTH}px; height: {height}px; background: {GROUND}; font-family: Inter, -apple-system, 'Segoe UI', sans-serif">
{host}
</div>
</x-dc>
<script type="text/x-dc" data-dc-script data-props='{props}'>
class Component extends DCLogic {{
renderVals() {{
return {{}};
}}
}}
</script>
</body>
</html>
"""


OUT.mkdir(parents=True, exist_ok=True)
for name, build in (("usage", diagram_usage), ("internals", diagram_internals)):
    title, cards, arrows, height, caption = build()
    for lang in ("en", "ko"):
        (OUT / f"{name}.{lang}.svg").write_text(svg_doc(lang, title, cards, arrows, height, caption))
    (OUT / f"{name}.dc.html").write_text(dc_doc(name, title, cards, arrows, height, caption))
    print(name, height)
