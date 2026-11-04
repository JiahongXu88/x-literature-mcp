#!/usr/bin/env python3
"""X Literature MCP PDF worker (deterministic PyMuPDF text / page rendering).

Called by src/pdf.ts via child_process.execFile (no shell).
Protocol: argv = <command> <pdf-path> [args...]; stdout carries exactly one JSON
object (last line); all diagnostics go to stderr. stdout is forced to UTF-8.

stdout isolation pattern adapted from PaperTeam backend/tools/parse_paper_pdf.py
(MIT, commit 642103d80dbe7ea63fc7131d1b022b9de74e3ed2): MuPDF's C layer can write
warnings straight to fd 1, so fd 1 is redirected to fd 2 while parsing and the
JSON is written through a duplicated original stdout handle.

Commands:
  extract <pdf>                 per-page blocks + text, headings candidates, metadata
  render  <pdf> <page> <scale>  PNG of one page (1-based), base64

No OCR, no model, no network.
"""

import base64
import json
import os
import re
import statistics
import sys

WORKER_VERSION = "w3"
MAX_PAGES = 2000
MAX_RENDER_PIXELS = 2400  # longest edge cap for rendered pages

NUMBERED_HEADING = re.compile(
    r"^\s*(?:第[一二三四五六七八九十\d]{1,3}[章节]\s*|\d{1,2}(?:\s?\.\s?\d{1,2}){0,3}\.?\s+|[ivxIVX]{1,4}\.\s+)[^\s\d)）,，.。]"
)
# Vocabulary borrowed from PaperTeam backend/src/paper/sectionChunking.ts CHINESE_HEADING/ENGLISH_HEADING
HEADING_FONT = re.compile(r"HZ|Hei|HT|Bold|Black|SimHei|黑", re.IGNORECASE)
BARE_NUMBER = re.compile(r"\d{1,2}(?:\.\d{1,2}){0,2}\.?")
KEYWORD_HEADING = re.compile(
    r"^\s*(?:\d{1,2}(?:\.\d{1,2})*[.、]?\s*)?"
    r"(摘\s*要|引\s*言|绪论|前言|相关工作|相关研究|研究背景|实验|实验与分析|实验结果|结果与分析|讨论|结\s*论|总结|结论与展望|致谢|参\s*考\s*文\s*献"
    r"|abstract|introduction|related work|background|methods?|methodology|experiments?|evaluation|results|discussion|conclusions?|acknowledg\w*|references|bibliography)"
    r"\s*[:：]?\s*(?:[（(]\s*references\s*[)）])?\s*$",
    re.IGNORECASE,
)


def main() -> int:
    protocol_out = os.fdopen(os.dup(1), "w", encoding="utf-8", closefd=True)
    os.dup2(2, 1)
    sys.stdout = sys.stderr
    try:
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # noqa: BLE001
        pass

    def emit(payload: dict) -> None:
        protocol_out.write(json.dumps(payload, ensure_ascii=False))
        protocol_out.write("\n")
        protocol_out.flush()

    if len(sys.argv) < 3:
        emit({"ok": False, "code": "usage", "error": "usage: pdf_worker.py extract|render <pdf> [page scale]"})
        return 2
    command, pdf_path = sys.argv[1], sys.argv[2]
    try:
        import pymupdf  # noqa: PLC0415
    except ImportError:
        try:
            import fitz as pymupdf  # noqa: PLC0415  (older PyMuPDF)
        except ImportError:
            emit({"ok": False, "code": "dependency_missing", "error": "PyMuPDF not installed: pip install pymupdf"})
            return 3
    try:
        pymupdf.TOOLS.mupdf_display_errors(False)
        pymupdf.TOOLS.mupdf_display_warnings(False)
    except Exception:  # noqa: BLE001
        pass

    try:
        doc = pymupdf.open(pdf_path)
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "code": "open_failed", "error": f"cannot open PDF: {exc}"})
        return 4
    if getattr(doc, "needs_pass", False):
        emit({"ok": False, "code": "encrypted", "error": "PDF is password protected"})
        return 4
    if doc.page_count == 0:
        emit({"ok": False, "code": "empty", "error": "PDF has 0 pages"})
        return 4

    try:
        if command == "extract":
            emit(extract(doc, pymupdf))
        elif command == "render":
            page = int(sys.argv[3])
            scale = float(sys.argv[4]) if len(sys.argv) > 4 else 1.5
            emit(render(doc, page, scale, pymupdf))
        else:
            emit({"ok": False, "code": "usage", "error": f"unknown command {command}"})
            return 2
        return 0
    except Exception as exc:  # noqa: BLE001
        emit({"ok": False, "code": "extract_failed", "error": f"{type(exc).__name__}: {exc}"})
        return 5


def extract(doc, pymupdf) -> dict:
    page_count = min(doc.page_count, MAX_PAGES)
    notes = []
    if doc.page_count > MAX_PAGES:
        notes.append(f"page cap {MAX_PAGES} reached; later pages not extracted")
    pages = []
    sizes = []
    heading_lines = []  # (page, text, size, bold)
    for index in range(page_count):
        page = doc[index]
        width = float(page.rect.width) or 1.0
        blocks = []
        for raw in page.get_text("blocks"):
            if len(raw) < 7 or raw[6] != 0:
                continue
            text = raw[4].replace("\r\n", "\n").replace("\r", "\n").strip()
            if text == "":
                continue
            blocks.append({"text": text, "bbox": [round(float(v), 1) for v in raw[:4]]})
        image_count = 0
        try:
            image_count = len(page.get_images(full=False))
        except Exception:  # noqa: BLE001
            pass
        # span-level font info for heading candidates
        try:
            data = page.get_text("dict")
        except Exception:  # noqa: BLE001
            data = {"blocks": []}
        for block in data.get("blocks", []):
            lines = block.get("lines", [])
            for li, line in enumerate(lines):
                spans = line.get("spans", [])
                line_text = clean_line("".join(span.get("text", "") for span in spans))
                if line_text == "":
                    continue
                size = max((float(span.get("size", 0)) for span in spans), default=0.0)
                sizes.extend([size] * max(1, len(line_text) // 10))
                if len(line_text) > 40:
                    continue
                font_spans = list(spans)
                if BARE_NUMBER.fullmatch(line_text) and li + 1 < len(lines):
                    nxt_spans = lines[li + 1].get("spans", [])
                    nxt = clean_line("".join(span.get("text", "") for span in nxt_spans))
                    if 0 < len(nxt) <= 36:
                        line_text = f"{line_text} {nxt}"
                        font_spans = font_spans + list(nxt_spans)
                heading_lines.append((index + 1, line_text, size, heading_font_share(font_spans) >= 0.6))
        pages.append(
            {
                "page": index + 1,
                "width": round(width, 1),
                "height": round(float(page.rect.height), 1),
                "blocks": blocks,
                "imageCount": image_count,
                "twoColumn": looks_two_column(blocks, width),
            }
        )
    body_size = statistics.median(sizes) if sizes else 0.0
    headings = []
    for page_no, text, size, bold in heading_lines:
        keyword = KEYWORD_HEADING.match(text) is not None
        numbered = (
            NUMBERED_HEADING.match(text) is not None
            and not BARE_NUMBER.fullmatch(text)
            and re.search(r"[一-鿿]|[A-Za-z]{3,}", text) is not None
        )
        larger = size >= body_size + 0.8
        if keyword and (bold or larger or len(text) <= 12) and not text[:1].islower():
            headings.append({"page": page_no, "text": text, "size": round(size, 1), "bold": bool(bold), "signal": "keyword"})
        elif numbered and (bold or larger) and len(text) >= 3 and not re.search(r"[=＝+≠<>，,。；;、%％]", text):
            headings.append({"page": page_no, "text": text, "size": round(size, 1), "bold": bool(bold), "signal": "numbered+font"})

    toc = [[int(e[0]), str(e[1]), int(e[2])] for e in doc.get_toc(simple=True)]
    meta = doc.metadata or {}
    return {
        "ok": True,
        "workerVersion": WORKER_VERSION,
        "pymupdfVersion": getattr(pymupdf, "__version__", getattr(pymupdf, "VersionBind", "unknown")),
        "pageCount": doc.page_count,
        "metadataTitle": str(meta.get("title", "") or "").strip(),
        "largestFontLine": largest_font_line(doc),
        "toc": toc,
        "bodyFontSize": round(body_size, 1),
        "headings": headings,
        "pages": pages,
        "isEncryptedFlag": bool(doc.is_encrypted),
        "notes": notes,
    }


def heading_font_share(spans) -> float:
    """Share of non-space characters set in a bold / Hei-style font."""
    total = hit = 0
    for span in spans:
        n = len(str(span.get("text", "")).replace(" ", ""))
        total += n
        if (int(span.get("flags", 0)) & 16) or HEADING_FONT.search(str(span.get("font", ""))):
            hit += n
    return hit / total if total else 0.0


def clean_line(text: str) -> str:
    return re.sub(r"\s+", " ", text.replace("　", " ")).strip()


def looks_two_column(blocks, width: float) -> bool:
    """Both a substantial left-only and a substantial right-only text column exist."""
    left = right = 0
    for block in blocks:
        x0, _, x1, _ = block["bbox"]
        chars = len(block["text"])
        if chars < 8:
            continue
        if x1 <= width * 0.56 and x0 < width * 0.3:
            left += chars
        elif x0 >= width * 0.44:
            right += chars
    return left >= 400 and right >= 400


def largest_font_line(doc) -> str:
    try:
        data = doc[0].get_text("dict")
    except Exception:  # noqa: BLE001
        return ""
    best_size, best_text = 0.0, ""
    for block in data.get("blocks", []):
        for line in block.get("lines", []):
            text = "".join(span.get("text", "") for span in line.get("spans", [])).strip()
            size = max((span.get("size", 0) for span in line.get("spans", [])), default=0)
            if len(text) < 3 or text.isdigit() or "@" in text or len(text) > 200:
                continue
            if size > best_size:
                best_size, best_text = size, text
    return best_text


def render(doc, page_number: int, scale: float, pymupdf) -> dict:
    if page_number < 1 or page_number > doc.page_count:
        return {"ok": False, "code": "page_out_of_range", "error": f"page {page_number} not in 1..{doc.page_count}"}
    scale = max(0.5, min(scale, 3.0))
    page = doc[page_number - 1]
    longest = max(page.rect.width, page.rect.height) * scale
    if longest > MAX_RENDER_PIXELS:
        scale = MAX_RENDER_PIXELS / max(page.rect.width, page.rect.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(scale, scale), alpha=False)
    png = pix.tobytes("png")
    return {
        "ok": True,
        "page": page_number,
        "pageCount": doc.page_count,
        "width": pix.width,
        "height": pix.height,
        "scale": round(scale, 3),
        "mimeType": "image/png",
        "data": base64.b64encode(png).decode("ascii"),
    }


if __name__ == "__main__":
    sys.exit(main())
