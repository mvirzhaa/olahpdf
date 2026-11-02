"""Watermark dan unlock PDF."""
from __future__ import annotations

import io
import math
import os
import uuid
from pathlib import Path

import pikepdf
import pymupdf
from PIL import Image

from .common import (InputFile, Result, UserError, clamp, files_of, hex_to_rgb, open_pdf,
                     parse_pages, single_or_zip)

BASE_FONTS = {  # (biasa, tebal)
    "sans": ("helv", "hebo"),
    "serif": ("tiro", "tibo"),
    "mono": ("cour", "cobo"),
}
UNICODE_FONTS = [
    os.environ.get("WATERMARK_FONT", ""),
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
]


def _pick_font(family: str, bold: bool, text: str) -> pymupdf.Font:
    base = BASE_FONTS.get(family, BASE_FONTS["sans"])[1 if bold else 0]
    font = pymupdf.Font(base)
    if all(font.has_glyph(ord(c)) for c in text if not c.isspace()):
        return font
    for path in UNICODE_FONTS:  # teks di luar Latin-1 → pakai font Unicode bila tersedia
        if path and os.path.isfile(path):
            uf = pymupdf.Font(fontfile=path)
            if all(uf.has_glyph(ord(c)) for c in text if not c.isspace()):
                return uf
    return font


def _text_stamp(opts: dict) -> pymupdf.Document:
    text = (opts.get("text") or "").strip()
    if not text:
        raise UserError("Isi teks watermark.")
    size = clamp(opts.get("fontSize"), 6, 300, 48)
    font = _pick_font(opts.get("font", "sans"), bool(opts.get("bold", True)), text)
    lines = text.splitlines()[:10]
    width = max(font.text_length(line, fontsize=size) for line in lines)
    lh = size * 1.25
    pad = size * 0.15
    stamp = pymupdf.open()
    page = stamp.new_page(width=width + 2 * pad, height=lh * len(lines) + 2 * pad)
    tw = pymupdf.TextWriter(page.rect)
    for i, line in enumerate(lines):
        lw = font.text_length(line, fontsize=size)
        x = pad + (width - lw) / 2
        y = pad + size * 1.0 + i * lh
        tw.append((x, y), line, font=font, fontsize=size)
    tw.write_text(page, color=hex_to_rgb(opts.get("color"), (0.8, 0.1, 0.1)),
                  opacity=clamp(opts.get("opacity"), 0.02, 1, 0.3))
    return stamp


def _image_stamp(f: InputFile, opacity: float) -> pymupdf.Document:
    try:
        with Image.open(f.path) as im:
            im = im.convert("RGBA")
            if opacity < 1:
                alpha = im.getchannel("A").point(lambda a: int(a * opacity))
                im.putalpha(alpha)
            buf = io.BytesIO()
            im.save(buf, "PNG")
            w, h = im.size
    except Exception as exc:  # noqa: BLE001
        raise UserError("Gambar watermark tidak dapat dibaca.") from exc
    stamp = pymupdf.open()
    page = stamp.new_page(width=w, height=h)
    page.insert_image(page.rect, stream=buf.getvalue())
    return stamp


def _rotated_size(w: float, h: float, deg: float) -> tuple[float, float]:
    r = math.radians(deg)
    c, s = abs(math.cos(r)), abs(math.sin(r))
    return w * c + h * s, w * s + h * c


def _positions(page_rect: pymupdf.Rect, bw: float, bh: float, position: str, margin: float):
    W, H = page_rect.width, page_rect.height
    if position == "tile":
        gap_x, gap_y = bw * 0.6 + 20, bh * 0.8 + 20
        y, row = -bh / 2, 0
        while y < H:
            x = -bw / 2 + (row % 2) * (bw + gap_x) / 2
            while x < W:
                yield pymupdf.Rect(x, y, x + bw, y + bh)
                x += bw + gap_x
            y += bh + gap_y
            row += 1
        return
    vert, horiz = (position + "c")[:2] if len(position) == 2 else ("m", "c")
    xs = {"l": margin, "c": (W - bw) / 2, "r": W - bw - margin}
    ys = {"t": margin, "m": (H - bh) / 2, "b": H - bh - margin}
    x, y = xs.get(horiz, xs["c"]), ys.get(vert, ys["m"])
    yield pymupdf.Rect(x, y, x + bw, y + bh)


def watermark_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    wtype = opts.get("type", "text")
    rotation = clamp(opts.get("rotation"), -180, 180, 45)
    position = opts.get("position", "mc")
    overlay = opts.get("layer", "over") != "under"
    opacity = clamp(opts.get("opacity"), 0.02, 1, 0.3)
    if wtype == "image":
        imgs = files_of(inputs, "watermark")
        if not imgs:
            raise UserError("Unggah gambar untuk watermark.")
        stamp = _image_stamp(imgs[0], opacity)
        scale_pct = clamp(opts.get("imageScale"), 5, 100, 30)
    else:
        stamp = _text_stamp(opts)
        scale_pct = None

    paths, names = [], []
    for f in files_of(inputs):
        doc = open_pdf(f)
        targets = parse_pages(opts.get("pages"), doc.page_count)
        # watermark diletakkan di layer tersendiri agar bisa disembunyikan/dihapus kembali
        ocg = doc.add_ocg("Watermark (OlahPDF)", on=True)
        for pno in targets:
            page = doc[pno]
            if page.rotation:
                page.remove_rotation()  # koordinat tampilan == koordinat halaman
            sw, sh = stamp[0].rect.width, stamp[0].rect.height
            if scale_pct is not None:
                k = page.rect.width * scale_pct / 100 / sw
                sw, sh = sw * k, sh * k
            bw, bh = _rotated_size(sw, sh, rotation)
            limit = min(page.rect.width / bw, page.rect.height / bh, 1.0) if position != "tile" else 1.0
            bw, bh = bw * limit, bh * limit
            margin = min(page.rect.width, page.rect.height) * 0.04
            for rect in _positions(page.rect, bw, bh, position, margin):
                page.show_pdf_page(rect, stamp, 0, rotate=rotation, overlay=overlay, keep_proportion=True,
                                   oc=ocg)
        out = out_dir / f"{uuid.uuid4().hex}.pdf"
        doc.save(out, garbage=3, deflate=True, use_objstms=1)
        paths.append(out)
        names.append(f"{f.stem}_watermark.pdf")
    return single_or_zip(paths, names, out_dir, "pdf_watermark.zip")


def unlock_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    password = opts.get("password") or ""
    paths, names = [], []
    info = {"was_encrypted": False}
    for f in files_of(inputs):
        try:
            pdf = pikepdf.open(f.path, password=password)
        except pikepdf.PasswordError as exc:
            if password:
                raise UserError(f"Password untuk '{f.name}' salah.") from exc
            raise UserError(f"'{f.name}' memerlukan password untuk dibuka. Masukkan password-nya.") from exc
        except pikepdf.PdfError as exc:
            raise UserError(f"File '{f.name}' bukan PDF yang valid atau rusak.") from exc
        with pdf:
            if pdf.is_encrypted:
                info["was_encrypted"] = True
            out = out_dir / f"{uuid.uuid4().hex}.pdf"
            pdf.save(out, encryption=False)
        paths.append(out)
        names.append(f"{f.stem}_unlocked.pdf")
    return single_or_zip(paths, names, out_dir, "pdf_unlocked.zip", info)
