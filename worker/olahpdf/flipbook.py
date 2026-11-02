"""PDF → Flipbook HTML.

Setiap halaman dirender menjadi gambar WebP berukuran seragam, lalu disatukan dengan viewer
(assets/flipbook.html + StPageFlip) yang memberi efek halaman melengkung seperti kertas,
penanda halaman, daftar isi dari bookmark PDF, dan musik MP3 opsional yang bisa dinyalakan/dimatikan.

Keluaran:
- "single": satu file .html mandiri (gambar & musik disematkan base64) — mudah dibagikan.
- "zip": index.html + folder halaman/, thumb/, audio/ — cocok diunggah ke hosting/website.
"""
from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import os
import re
import uuid
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

import pymupdf
from PIL import Image

from .common import InputFile, Result, UserError, clamp, files_of, open_pdf, safe_stem

ASSETS = Path(__file__).parent / "assets"
MAX_PAGES = int(os.environ.get("FLIPBOOK_MAX_PAGES", "400"))
MAX_MUSIC_MB = int(os.environ.get("FLIPBOOK_MAX_MUSIC_MB", "30"))
QUALITY = {  # lebar halaman (px), kualitas WebP
    "compact": (1000, 72),
    "standard": (1400, 78),
    "high": (2000, 82),
}
THUMB_W = 220
PAGEFLIP_BANNER = ("/*! StPageFlip v2.0.7 | MIT License | Copyright (c) 2020 Nodlik | "
                   "https://github.com/Nodlik/StPageFlip */\n")


def _is_mp3(data: bytes) -> bool:
    if data[:3] == b"ID3":
        return True
    # tanpa tag ID3: cari sinkronisasi frame MPEG audio di awal file
    for i in range(min(len(data) - 1, 4096)):
        if data[i] == 0xFF and (data[i + 1] & 0xE0) == 0xE0 and (data[i + 1] & 0x06) != 0:
            return True
    return False


def _base_size(doc: pymupdf.Document, width_px: int) -> tuple[int, int]:
    """Ukuran halaman seragam berdasarkan rasio halaman yang paling sering muncul."""
    ratios: Counter = Counter()
    exact: dict[float, float] = {}
    for page in doc:
        r = page.rect
        if r.width > 0 and r.height > 0:
            key = round(r.width / r.height, 2)
            ratios[key] += 1
            exact.setdefault(key, r.width / r.height)
    ratio = exact[ratios.most_common(1)[0][0]] if ratios else 0.7071
    ratio = min(max(ratio, 0.3), 3.0)
    w = width_px if ratio <= 1 else int(width_px * min(ratio, 1.6))
    return w, max(1, round(w / ratio))


def _render(page: pymupdf.Page, W: int, H: int) -> Image.Image:
    r = page.rect
    zoom = min(W / r.width, H / r.height)
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False, annots=True)
    img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
    if img.size == (W, H):
        return img
    if abs(img.width / img.height - W / H) < 0.015:  # beda pembulatan saja → isi penuh, tanpa garis putih
        return img.resize((W, H), Image.LANCZOS)
    canvas = Image.new("RGB", (W, H), (255, 255, 255))
    canvas.paste(img, ((W - img.width) // 2, (H - img.height) // 2))
    return canvas


def _webp(img: Image.Image, quality: int) -> bytes:
    buf = io.BytesIO()
    img.save(buf, "WEBP", quality=quality, method=4)
    return buf.getvalue()


def _data_uri(mime: str, data: bytes) -> str:
    return f"data:{mime};base64,{base64.b64encode(data).decode('ascii')}"


def _outline(doc: pymupdf.Document) -> list[list]:
    out = []
    try:
        for lvl, title, page, *_ in doc.get_toc(simple=True):
            if page >= 1 and title.strip():
                out.append([int(lvl), title.strip()[:200], int(page) - 1])
    except Exception:  # noqa: BLE001 — daftar isi rusak tidak boleh menggagalkan flipbook
        return []
    return out[:1000]


def _render_template(data: dict, title: str) -> str:
    template = (ASSETS / "flipbook.html").read_text(encoding="utf-8")
    pageflip = PAGEFLIP_BANNER + (ASSETS / "page-flip.browser.js").read_text(encoding="utf-8")
    # JSON di dalam <script>: cegah penutupan tag lebih awal
    payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    payload = payload.replace("</", "<\\/").replace("<!--", "<\\!--")
    bg = data["bg"]
    out = template.replace("__TITLE__", html.escape(title, quote=True))
    out = out.replace("__BG__", bg)
    out = out.replace("/*__PAGEFLIP_JS__*/", pageflip.replace("</script", "<\\/script"))
    return out.replace("__BOOK_DATA__", payload)


def pdf_to_flipbook(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    f = files_of(inputs)[0]
    doc = open_pdf(f)
    if doc.page_count > MAX_PAGES:
        raise UserError(f"Flipbook maksimal {MAX_PAGES} halaman (dokumen ini {doc.page_count} halaman). "
                        "Pisahkan PDF terlebih dahulu.")
    width_px, quality = QUALITY.get(opts.get("quality"), QUALITY["standard"])
    W, H = _base_size(doc, width_px)
    package = "zip" if opts.get("package") == "zip" else "single"
    bg = opts.get("background") if re.fullmatch(r"#[0-9a-fA-F]{6}", str(opts.get("background") or "")) else "#2f343c"
    title = (opts.get("title") or "").strip() or (doc.metadata or {}).get("title", "").strip() or Path(f.name).stem
    title = title[:150]

    # Musik (opsional)
    music_file = next(iter(files_of(inputs, "music")), None)
    music_bytes = None
    if music_file:
        if music_file.path.stat().st_size > MAX_MUSIC_MB * 1024 * 1024:
            raise UserError(f"Ukuran file musik maksimal {MAX_MUSIC_MB} MB.")
        music_bytes = music_file.path.read_bytes()
        if not _is_mp3(music_bytes):
            raise UserError("File musik harus berformat MP3.")

    pages: list[bytes] = []
    thumbs: list[bytes] = []
    th_h = round(THUMB_W * H / W)
    for page in doc:
        img = _render(page, W, H)
        pages.append(_webp(img, quality))
        thumbs.append(_webp(img.resize((THUMB_W, th_h), Image.LANCZOS), 60))

    # ID stabil: buku yang sama → penanda pembaca tetap tersimpan meski file dibuat ulang
    h = hashlib.sha1()
    with open(f.path, "rb") as fh:
        h.update(fh.read(2 * 1024 * 1024))
    h.update(str(f.path.stat().st_size).encode())
    h.update(title.encode())
    book_id = h.hexdigest()[:16]

    data = {
        "id": book_id,
        "title": title,
        "width": W,
        "height": H,
        "cover": bool(opts.get("cover", True)),
        "flipSound": bool(opts.get("flipSound", True)),
        "bg": bg,
        "outline": _outline(doc),
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "music": None,
    }
    music_meta = None
    if music_bytes is not None:
        music_meta = {
            "name": music_file.name[:120],
            "loop": bool(opts.get("musicLoop", True)),
            "autoplay": bool(opts.get("musicAutoplay", True)),
            "volume": round(clamp(opts.get("musicVolume"), 0.05, 1, 0.6), 2),
        }

    stem = safe_stem(title.replace("/", "-").replace("\\", "-"), "flipbook")
    n = len(pages)
    if package == "single":
        data["pages"] = [_data_uri("image/webp", b) for b in pages]
        data["thumbs"] = [_data_uri("image/webp", b) for b in thumbs]
        if music_meta:
            data["music"] = {**music_meta, "src": _data_uri("audio/mpeg", music_bytes)}
        out = out_dir / f"{uuid.uuid4().hex}.html"
        out.write_text(_render_template(data, title), encoding="utf-8")
        name = f"{stem}_flipbook.html"
    else:
        data["pages"] = [f"halaman/{i + 1:04d}.webp" for i in range(n)]
        data["thumbs"] = [f"thumb/{i + 1:04d}.webp" for i in range(n)]
        if music_meta:
            data["music"] = {**music_meta, "src": "audio/musik.mp3"}
        out = out_dir / f"{uuid.uuid4().hex}.zip"
        folder = f"{stem}_flipbook"
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(f"{folder}/index.html", _render_template(data, title))
            for i in range(n):
                zf.writestr(zipfile.ZipInfo(f"{folder}/halaman/{i + 1:04d}.webp"), pages[i], zipfile.ZIP_STORED)
                zf.writestr(zipfile.ZipInfo(f"{folder}/thumb/{i + 1:04d}.webp"), thumbs[i], zipfile.ZIP_STORED)
            if music_bytes is not None:
                zf.writestr(zipfile.ZipInfo(f"{folder}/audio/musik.mp3"), music_bytes, zipfile.ZIP_STORED)
            zf.write(ASSETS / "page-flip.LICENSE", f"{folder}/LICENSE-StPageFlip.txt")
        name = f"{folder}.zip"

    return Result(out, name, {"pages": n, "music": bool(music_bytes), "package": package,
                              "outline": len(data["outline"])})
