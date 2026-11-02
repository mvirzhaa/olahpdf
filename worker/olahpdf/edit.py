"""Editor PDF: susun ulang/putar/hapus/duplikat/sisip halaman dan tambah objek
(teks, gambar, bentuk, coretan, stabilo, whiteout, ganti teks asli).

Format options["edit"] yang dikirim editor di browser:
{
  "pages": [
    {"src": {"file": 0, "page": 2}, "rotate": 90, "objects": [...]},
    {"blank": {"w": 595, "h": 842}, "rotate": 0, "objects": [...]}
  ]
}
- src.file: 0 = PDF utama (field "files"), 1.. = PDF tambahan (field "extra") sesuai urutan.
- Koordinat objek dalam point PDF, titik (0,0) di kiri-atas halaman SEBAGAIMANA TAMPIL
  dengan rotasi aslinya (sebelum rotasi tambahan "rotate" dari pengguna).
- Objek gambar merujuk "asset": indeks file pada field "assets".
"""
from __future__ import annotations

import html
import io
import uuid
from pathlib import Path

import pymupdf
from PIL import Image

from .common import InputFile, Result, UserError, clamp, files_of, hex_to_rgb, open_pdf

MAX_PAGES = 3000
FONT_CSS = {"sans": "sans-serif", "serif": "serif", "mono": "monospace"}


def _rect(o: dict, page: pymupdf.Page) -> pymupdf.Rect:
    try:
        x, y = float(o["x"]), float(o["y"])
        w, h = max(1.0, float(o["w"])), max(1.0, float(o["h"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise UserError("Data objek editor tidak valid.") from exc
    return pymupdf.Rect(x, y, x + w, y + h)


def _color(v, default=None):
    if v in (None, "", "none", "transparent"):
        return default
    return hex_to_rgb(v, default or (0, 0, 0))


def _insert_text(page: pymupdf.Page, rect: pymupdf.Rect, o: dict):
    text = str(o.get("text") or "")
    if not text.strip():
        return
    size = clamp(o.get("size"), 4, 400, 14)
    css = (
        "* { margin:0; padding:0; }\n"
        f"body {{ font-family: {FONT_CSS.get(o.get('font'), 'sans-serif')}; font-size: {size:.2f}px;"
        f" line-height: 1.2; color: {o.get('color') or '#000000'};"
        f" font-weight: {'bold' if o.get('bold') else 'normal'};"
        f" font-style: {'italic' if o.get('italic') else 'normal'};"
        f" text-align: {o.get('align') if o.get('align') in ('left', 'center', 'right') else 'left'};"
        f" text-decoration: {'underline' if o.get('underline') else 'none'}; }}"
    )
    body = "<br>".join(html.escape(line).replace("  ", " &nbsp;") for line in text.split("\n"))
    # Kotak dilebarkan sedikit agar perbedaan metrik font browser vs PDF tidak membuat teks terbungkus.
    box = pymupdf.Rect(rect.x0, rect.y0, rect.x1 + size * 0.6, max(rect.y1, rect.y0 + size * 1.3) + size)
    page.insert_htmlbox(box, f"<body>{body}</body>", css=css, scale_low=0.5,
                        opacity=clamp(o.get("opacity"), 0.05, 1, 1))


def _span_style(page: pymupdf.Page, rect: pymupdf.Rect) -> dict:
    """Ambil gaya teks asli (ukuran, warna, jenis font) pada area yang akan diganti."""
    style = {}
    try:
        d = page.get_text("dict", clip=rect)
    except Exception:  # noqa: BLE001
        return style
    for block in d.get("blocks", []):
        for line in block.get("lines", []):
            for span in line.get("spans", []):
                if not span.get("text", "").strip():
                    continue
                c = span.get("color", 0)
                style["color"] = f"#{c:06x}"
                style["size"] = span.get("size")
                flags = span.get("flags", 0)
                name = (span.get("font") or "").lower()
                style["bold"] = bool(flags & 16) or "bold" in name
                style["italic"] = bool(flags & 2) or "italic" in name or "oblique" in name
                if flags & 8 or "mono" in name or "courier" in name:
                    style["font"] = "mono"
                elif flags & 4 or "times" in name or "serif" in name and "sans" not in name:
                    style["font"] = "serif"
                else:
                    style["font"] = "sans"
                return style
    return style


def _apply_text_edits(page: pymupdf.Page, edits: list[dict]) -> list[tuple[pymupdf.Rect, dict]]:
    """Hapus teks asli (redaksi sungguhan, bukan sekadar ditutup) lalu kembalikan teks pengganti."""
    pending = []
    for o in edits:
        orig = pymupdf.Rect(o["orig"]) if isinstance(o.get("orig"), (list, tuple)) and len(o["orig"]) == 4 else _rect(o, page)
        # gaya asli dipakai sebagai dasar; editor hanya mengirim field gaya yang diubah pengguna
        style = _span_style(page, orig)
        overrides = {k: v for k, v in o.items()
                     if k in ("size", "color", "font", "bold", "italic", "align", "underline") and v is not None}
        merged = {**style, **overrides, "text": o.get("text", "")}
        # perkecil sedikit agar huruf baris tetangga tidak ikut terhapus
        shrink = min(orig.height * 0.15, 1.5)
        page.add_redact_annot(orig + (0.5, shrink, -0.5, -shrink), fill=False, cross_out=False)
        pending.append((_rect(o, page), merged))
    if pending:
        page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                              graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                              text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    return pending


def _load_asset(assets: list[InputFile], idx, opacity: float) -> bytes:
    try:
        f = assets[int(idx)]
    except (TypeError, ValueError, IndexError) as exc:
        raise UserError("Gambar pada editor tidak ditemukan.") from exc
    with Image.open(f.path) as im:
        im = im.convert("RGBA")
        if opacity < 1:
            im.putalpha(im.getchannel("A").point(lambda a: int(a * opacity)))
        if max(im.size) > 3000:
            im.thumbnail((3000, 3000))
        buf = io.BytesIO()
        im.save(buf, "PNG", optimize=True)
        return buf.getvalue()


def _draw_object(page: pymupdf.Page, o: dict, assets: list[InputFile]):
    t = o.get("type")
    opacity = clamp(o.get("opacity"), 0.05, 1, 1)
    if t == "text":
        _insert_text(page, _rect(o, page), o)
    elif t == "image":
        page.insert_image(_rect(o, page), stream=_load_asset(assets, o.get("asset"), opacity),
                          keep_proportion=False)
    elif t in ("rect", "ellipse"):
        stroke = _color(o.get("stroke"))
        fill = _color(o.get("fill"))
        width = clamp(o.get("strokeWidth"), 0, 50, 2) if stroke else 0
        if not stroke and not fill:
            return
        draw = page.draw_rect if t == "rect" else page.draw_oval
        draw(_rect(o, page), color=stroke, fill=fill, width=width,
             stroke_opacity=opacity, fill_opacity=opacity)
    elif t == "whiteout":
        page.draw_rect(_rect(o, page), color=None, fill=_color(o.get("fill"), (1, 1, 1)), width=0)
    elif t == "highlight":
        r = _rect(o, page)
        annot = page.add_highlight_annot(r)
        annot.set_colors(stroke=_color(o.get("color"), (1, 0.92, 0.23)))
        annot.set_opacity(clamp(o.get("opacity"), 0.1, 1, 0.5))
        annot.update()
    elif t == "line":
        try:
            p1 = pymupdf.Point(float(o["x1"]), float(o["y1"]))
            p2 = pymupdf.Point(float(o["x2"]), float(o["y2"]))
        except (KeyError, TypeError, ValueError):
            return
        page.draw_line(p1, p2, color=_color(o.get("stroke"), (0, 0, 0)),
                       width=clamp(o.get("strokeWidth"), 0.25, 50, 2), stroke_opacity=opacity, lineCap=1)
    elif t == "draw":
        pts = []
        for p in (o.get("points") or [])[:20000]:
            try:
                pts.append(pymupdf.Point(float(p[0]), float(p[1])))
            except (TypeError, ValueError, IndexError):
                continue
        if len(pts) == 1:
            pts.append(pts[0] + (0.01, 0.01))
        if len(pts) >= 2:
            page.draw_polyline(pts, color=_color(o.get("stroke"), (0, 0, 0)),
                               width=clamp(o.get("strokeWidth"), 0.25, 50, 2),
                               stroke_opacity=opacity, lineCap=1, lineJoin=1, closePath=False)


def edit_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    spec = opts.get("edit") or {}
    pages = spec.get("pages") if isinstance(spec, dict) else None
    if not isinstance(pages, list) or not pages:
        raise UserError("Dokumen hasil edit tidak boleh kosong (minimal 1 halaman).")
    if len(pages) > MAX_PAGES:
        raise UserError(f"Maksimal {MAX_PAGES} halaman.")

    main = files_of(inputs, "files")
    sources = [open_pdf(f, opts.get("password")) for f in main[:1]]
    sources += [open_pdf(f) for f in files_of(inputs, "extra")]
    assets = files_of(inputs, "assets")
    if not sources:
        raise UserError("Unggah file PDF yang akan diedit.")

    out = pymupdf.open()
    for i, p in enumerate(pages):
        if not isinstance(p, dict):
            raise UserError("Data halaman tidak valid.")
        if p.get("src"):
            try:
                src = sources[int(p["src"]["file"])]
                pno = int(p["src"]["page"])
            except (KeyError, TypeError, ValueError, IndexError) as exc:
                raise UserError(f"Sumber halaman ke-{i + 1} tidak valid.") from exc
            if not 0 <= pno < src.page_count:
                raise UserError(f"Halaman sumber ke-{i + 1} tidak ada.")
            out.insert_pdf(src, from_page=pno, to_page=pno)
            page = out[-1]
            if page.rotation:
                page.remove_rotation()
        else:
            blank = p.get("blank") or {}
            w = clamp(blank.get("w"), 72, 14400, 595.28)
            h = clamp(blank.get("h"), 72, 14400, 841.89)
            page = out.new_page(width=w, height=h)

        objects = [o for o in (p.get("objects") or []) if isinstance(o, dict)]
        text_edits = [o for o in objects if o.get("type") == "textEdit"]
        for rect, style in _apply_text_edits(page, text_edits):
            _insert_text(page, rect, style)
        for o in objects:
            if o.get("type") != "textEdit":
                _draw_object(page, o, assets)

        extra_rot = int(p.get("rotate") or 0) % 360
        if extra_rot not in (0, 90, 180, 270):
            extra_rot = 0
        if extra_rot:
            page.set_rotation(extra_rot)

    # metadata & bookmark dari dokumen utama tetap dibawa bila struktur halamannya sama
    out.set_metadata({k: v for k, v in (sources[0].metadata or {}).items() if v and k in
                      ("title", "author", "subject", "keywords")})
    try:
        out.subset_fonts()  # font cadangan (mis. untuk simbol/aksara non-Latin) bisa besar
    except Exception:  # noqa: BLE001
        pass
    path = out_dir / f"{uuid.uuid4().hex}.pdf"
    out.save(path, garbage=4, deflate=True, use_objstms=1)
    name = f"{main[0].stem}_edited.pdf" if main else "hasil_edit.pdf"
    return Result(path, name, {"pages": out.page_count})
