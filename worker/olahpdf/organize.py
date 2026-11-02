"""Merge, split, dan compress PDF."""
from __future__ import annotations

import shutil
import uuid
from pathlib import Path

import pymupdf

from .common import (InputFile, Result, UserError, files_of, open_pdf, parse_pages, parse_ranges,
                     single_or_zip)


def merge_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    files = files_of(inputs)
    if len(files) < 2:
        raise UserError("Pilih minimal 2 file PDF untuk digabungkan.")
    bookmarks = opts.get("bookmarks", True) is not False
    out = pymupdf.open()
    toc: list[list] = []
    for f in files:
        src = open_pdf(f)
        start = out.page_count
        out.insert_pdf(src)
        if bookmarks:
            toc.append([1, Path(f.name).stem[:120], start + 1])
            for lvl, title, page, *_ in src.get_toc(simple=False):
                if page > 0:
                    toc.append([lvl + 1, title, start + page])
        src.close()
    if bookmarks and toc:
        try:
            out.set_toc(toc)
        except Exception:  # noqa: BLE001  — TOC asli yang tidak konsisten tidak boleh menggagalkan merge
            out.set_toc([t for t in toc if t[0] == 1])
    path = out_dir / f"{uuid.uuid4().hex}.pdf"
    out.save(path, garbage=4, deflate=True, use_objstms=1)
    return Result(path, "gabungan.pdf", {"pages": out.page_count, "files": len(files)})


def _sub_pdf(src: pymupdf.Document, pages: list[int], out_dir: Path) -> Path:
    out = pymupdf.open()
    # insert_pdf per rentang berurutan lebih cepat daripada per halaman
    run_start = prev = None
    for p in pages + [None]:
        if p is not None and prev is not None and p == prev + 1:
            prev = p
            continue
        if run_start is not None:
            out.insert_pdf(src, from_page=run_start, to_page=prev)
        run_start = prev = p
    path = out_dir / f"{uuid.uuid4().hex}.pdf"
    out.save(path, garbage=3, deflate=True, use_objstms=1)
    return path


def _label(pages: list[int]) -> str:
    if len(pages) == 1:
        return str(pages[0] + 1)
    if pages == list(range(pages[0], pages[-1] + 1)):
        return f"{pages[0] + 1}-{pages[-1] + 1}"
    if len(pages) <= 6:
        return ",".join(str(p + 1) for p in pages)
    return f"{pages[0] + 1}-dst"


def split_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    files = files_of(inputs)
    f = files[0]
    src = open_pdf(f)
    n = src.page_count
    mode = opts.get("mode", "ranges")
    if mode == "all":
        groups = [[i] for i in range(n)]
    elif mode == "fixed":
        every = int(opts.get("every") or 1)
        if every < 1:
            raise UserError("Jumlah halaman per file minimal 1.")
        groups = [list(range(i, min(i + every, n))) for i in range(0, n, every)]
    elif mode == "extract":
        groups = [parse_pages(opts.get("pages"), n)]
    else:
        groups = parse_ranges(opts.get("ranges", ""), n)
    if len(groups) > 1000:
        raise UserError("Hasil pemisahan terlalu banyak (maksimal 1000 file).")
    paths, names = [], []
    for g in groups:
        paths.append(_sub_pdf(src, g, out_dir))
        names.append(f"{f.stem}_hal-{_label(g)}.pdf")
    return single_or_zip(paths, names, out_dir, f"{f.stem}_split.zip", {"files": len(paths), "source_pages": n})


# level → (ambang dpi, target dpi, kualitas JPEG)
COMPRESS_LEVELS = {
    "low": (220, 200, 85),
    "recommended": (150, 120, 70),
    "extreme": (96, 72, 45),
}


def compress_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    level = opts.get("level", "recommended")
    threshold, target, quality = COMPRESS_LEVELS.get(level, COMPRESS_LEVELS["recommended"])
    paths, names = [], []
    total_before = total_after = 0
    for f in files_of(inputs):
        before = f.path.stat().st_size
        doc = open_pdf(f)
        try:
            doc.rewrite_images(dpi_threshold=threshold, dpi_target=target, quality=quality,
                               lossy=True, lossless=True, bitonal=False, color=True, gray=True)
        except Exception:  # noqa: BLE001 — sebagian gambar eksotis tidak bisa ditulis ulang; lanjut saja
            pass
        try:
            doc.subset_fonts()
        except Exception:  # noqa: BLE001
            pass
        if level == "extreme":
            doc.scrub(metadata=False, xml_metadata=True, javascript=False, embedded_files=False,
                      attached_files=False, thumbnails=True, reset_fields=False, reset_responses=False,
                      remove_links=False, clean_pages=True, hidden_text=False, redactions=False,
                      redact_images=0)
        out = out_dir / f"{uuid.uuid4().hex}.pdf"
        doc.save(out, garbage=4, deflate=True, deflate_images=True, deflate_fonts=True,
                 use_objstms=1, clean=True)
        doc.close()
        after = out.stat().st_size
        if after >= before:  # tidak lebih kecil → kembalikan file asli
            shutil.copyfile(f.path, out)
            after = before
        total_before += before
        total_after += after
        paths.append(out)
        names.append(f"{f.stem}_compressed.pdf")
    saved = 0 if not total_before else round((1 - total_after / total_before) * 100, 1)
    info = {"size_before": total_before, "size_after": total_after, "saved_percent": max(saved, 0)}
    return single_or_zip(paths, names, out_dir, "pdf_compressed.zip", info)
