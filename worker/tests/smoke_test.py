"""Uji asap semua processor tanpa database/API.

Jalankan dari folder worker:  python -m tests.smoke_test [folder_keluaran]
Membuat file contoh, menjalankan setiap tool, lalu memeriksa hasilnya.
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
import time
import traceback
import zipfile
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from olahpdf import PROCESSORS  # noqa: E402
from olahpdf.common import InputFile, UserError  # noqa: E402


def make_samples(d: Path) -> None:
    from docx import Document
    from openpyxl import Workbook
    from pptx import Presentation

    im = Image.new("RGB", (1200, 800), "#3a7bd5")
    ImageDraw.Draw(im).ellipse((300, 150, 900, 650), fill="#ffd200")
    im.save(d / "foto.jpg", quality=90)
    logo = Image.new("RGBA", (600, 300), (0, 0, 0, 0))
    ImageDraw.Draw(logo).rectangle((20, 20, 580, 280), fill=(220, 30, 60, 220))
    logo.save(d / "logo.png")

    doc = pymupdf.open()
    for i in range(5):
        p = doc.new_page()
        p.insert_text((72, 80), f"Laporan Kegiatan - Halaman {i + 1}", fontsize=18, fontname="hebo")
        p.insert_text((72, 120), "Teks ini akan diedit oleh pengguna.", fontsize=12, color=(0.1, 0.3, 0.7))
        y = 160
        for r in [["No", "Nama", "Jumlah"], ["1", "Kertas A4", "1.250"], ["2", "Tinta", "35"], ["3", "Map", "2.500,50"]]:
            x = 72
            for c in r:
                p.draw_rect(pymupdf.Rect(x, y, x + 150, y + 22), color=(0, 0, 0), width=0.7)
                p.insert_text((x + 4, y + 15), c, fontsize=11)
                x += 150
            y += 22
        p.insert_image(pymupdf.Rect(72, 300, 372, 500), filename=str(d / "foto.jpg"))
    doc[2].set_rotation(90)
    doc.set_toc([[1, "Bab 1", 1], [2, "Sub", 2], [1, "Bab 2", 4]])
    doc.save(d / "contoh.pdf")
    # PDF dengan watermark ala Word/Acrobat (artefak) + teks "DRAFT" biasa
    wm = pymupdf.open(d / "contoh.pdf")
    for p in wm:
        xref = p.get_contents()[0]
        stream = wm.xref_stream(xref)
        wm.update_stream(xref, stream + b"\n/Artifact <</Type /Pagination /Subtype /Watermark>> BDC q 0.8 0 0 rg BT /Helv 60 Tf 150 400 Td (CONFIDENTIAL) Tj ET Q EMC\n")
        p.insert_text((200, 780), "DRAFT", fontsize=40, color=(0.7, 0.7, 0.7))
    wm.save(d / "berwatermark.pdf")
    doc.save(d / "contoh2.pdf")
    doc.save(d / "terkunci.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="rahasia", owner_pw="o1", permissions=0)
    doc.save(d / "restriksi.pdf", encryption=pymupdf.PDF_ENCRYPT_AES_256, user_pw="", owner_pw="o1",
             permissions=pymupdf.PDF_PERM_PRINT)

    dx = Document()
    dx.add_heading("Dokumen Uji", 0)
    dx.add_paragraph("Ini paragraf uji untuk konversi Word ke PDF.")
    dx.save(d / "uji.docx")
    pr = Presentation()
    s = pr.slides.add_slide(pr.slide_layouts[1])
    s.shapes.title.text = "Presentasi Uji"
    s.placeholders[1].text = "Poin pertama"
    pr.save(d / "uji.pptx")
    wb = Workbook()
    wb.active.append(["Nama", "Nilai"])
    wb.active.append(["Andi", 90])
    wb.save(d / "uji.xlsx")
    # MP3 senyap kecil (frame MPEG-1 Layer III 128 kbps) untuk uji flipbook
    (d / "musik.mp3").write_bytes((b"\xff\xfb\x90\x64" + b"\x00" * 413) * 40)
    (d / "halaman.html").write_text(
        "<html><body style='font-family:sans-serif'><h1 style='color:#2563eb'>Halo OlahPDF</h1>"
        "<p>Konversi HTML ke PDF dengan Chromium.</p></body></html>", encoding="utf-8")


def f(d: Path, name: str, field: str = "files") -> InputFile:
    p = d / name
    return InputFile(field=field, name=name, path=p, size=p.stat().st_size)


EDIT_SPEC = {"pages": [
    {"src": {"file": 0, "page": 1}, "rotate": 0, "objects": [
        {"type": "textEdit", "orig": [72, 108, 290, 124], "x": 72, "y": 108, "w": 260, "h": 16,
         "text": "Teks ini SUDAH diganti lewat editor."},
        {"type": "text", "x": 300, "y": 40, "w": 200, "h": 20, "text": "Disetujui ✓ — Rektorat", "size": 14,
         "color": "#16a34a", "bold": True},
        {"type": "rect", "x": 60, "y": 150, "w": 470, "h": 110, "stroke": "#dc2626", "strokeWidth": 2},
        {"type": "ellipse", "x": 400, "y": 300, "w": 120, "h": 80, "fill": "#2563eb", "opacity": 0.4},
        {"type": "highlight", "x": 70, "y": 64, "w": 300, "h": 22},
        {"type": "whiteout", "x": 72, "y": 300, "w": 100, "h": 60},
        {"type": "line", "x1": 72, "y1": 560, "x2": 500, "y2": 560, "stroke": "#000000", "strokeWidth": 1},
        {"type": "draw", "points": [[100, 600], [130, 620], [160, 600], [190, 630]], "stroke": "#7c3aed", "strokeWidth": 3},
        {"type": "image", "x": 380, "y": 620, "w": 150, "h": 75, "asset": 0, "opacity": 0.9},
    ]},
    {"src": {"file": 0, "page": 2}, "rotate": 90, "objects": [
        {"type": "text", "x": 40, "y": 40, "w": 200, "h": 20, "text": "Halaman berotasi", "size": 16}]},
    {"blank": {"w": 595.28, "h": 841.89}, "rotate": 0, "objects": [
        {"type": "text", "x": 72, "y": 72, "w": 400, "h": 40, "text": "Halaman kosong baru\nbaris kedua", "size": 20,
         "font": "serif", "align": "center"}]},
    {"src": {"file": 1, "page": 0}, "rotate": 180, "objects": []},
    {"src": {"file": 0, "page": 0}, "rotate": 0, "objects": []},
]}


def cases(d: Path):
    return [
        ("jpg-to-pdf", [f(d, "foto.jpg"), f(d, "logo.png")], {"pageSize": "a4", "margin": "small"}),
        ("jpg-to-pdf", [f(d, "foto.jpg")], {"pageSize": "fit"}),
        ("word-to-pdf", [f(d, "uji.docx")], {}),
        ("powerpoint-to-pdf", [f(d, "uji.pptx")], {}),
        ("excel-to-pdf", [f(d, "uji.xlsx")], {}),
        ("html-to-pdf", [f(d, "halaman.html")], {"source": "file"}),
        ("pdf-to-jpg", [f(d, "contoh.pdf")], {"mode": "pages", "dpi": 100}),
        ("pdf-to-jpg", [f(d, "contoh.pdf")], {"mode": "extract"}),
        ("pdf-to-word", [f(d, "contoh.pdf")], {}),
        ("pdf-to-powerpoint", [f(d, "contoh.pdf")], {"mode": "image"}),
        ("pdf-to-powerpoint", [f(d, "contoh.pdf")], {"mode": "editable"}),
        ("pdf-to-excel", [f(d, "contoh.pdf")], {"layout": "per-page"}),
        ("pdf-to-excel", [f(d, "contoh.pdf")], {"layout": "single"}),
        ("pdf-to-pdfa", [f(d, "contoh.pdf")], {"level": "2b"}),
        ("merge", [f(d, "contoh.pdf"), f(d, "contoh2.pdf")], {}),
        ("split", [f(d, "contoh.pdf")], {"mode": "ranges", "ranges": "1-2, 3, 4-5"}),
        ("split", [f(d, "contoh.pdf")], {"mode": "extract", "pages": "1,3,5"}),
        ("split", [f(d, "contoh.pdf")], {"mode": "fixed", "every": 2}),
        ("compress", [f(d, "contoh.pdf")], {"level": "extreme"}),
        ("watermark", [f(d, "contoh.pdf")], {"type": "text", "text": "RAHASIA", "rotation": 45, "opacity": 0.3}),
        ("watermark", [f(d, "contoh.pdf")], {"type": "text", "text": "UIKA BOGOR", "position": "tile", "fontSize": 24}),
        ("watermark", [f(d, "contoh.pdf"), f(d, "logo.png", "watermark")],
         {"type": "image", "position": "br", "rotation": 0, "imageScale": 20, "opacity": 0.6}),
        ("unlock", [f(d, "terkunci.pdf")], {"password": "rahasia"}),
        ("unlock", [f(d, "restriksi.pdf")], {}),
        ("unlock", [f(d, "terkunci.pdf")], {"password": "salah"}),  # harus gagal dengan pesan jelas
        ("remove-watermark", [f(d, "berwatermark.pdf")], {"text": "DRAFT"}),
        ("remove-watermark", [f(d, "contoh.pdf")], {}),  # tanpa watermark → pesan jelas
        ("pdf-to-flipbook", [f(d, "contoh.pdf"), f(d, "musik.mp3", "music")], {"title": "Uji Flipbook", "musicVolume": 0.5}),
        ("pdf-to-flipbook", [f(d, "contoh.pdf")], {"package": "zip", "quality": "compact", "cover": False}),
        ("edit", [f(d, "contoh.pdf"), f(d, "contoh2.pdf", "extra"), f(d, "logo.png", "assets")], {"edit": EDIT_SPEC}),
    ]


def main():
    out_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(tempfile.mkdtemp(prefix="olahpdf_smoke_"))
    samples = out_root / "samples"
    samples.mkdir(parents=True, exist_ok=True)
    make_samples(samples)
    ok = fail = 0
    for i, (tool, inputs, opts) in enumerate(cases(samples), start=1):
        out_dir = out_root / f"{i:02d}_{tool}"
        shutil.rmtree(out_dir, ignore_errors=True)
        out_dir.mkdir(parents=True)
        t0 = time.time()
        try:
            res = PROCESSORS[tool](inputs, opts, out_dir)
            dest = out_dir / res.name
            res.path.replace(dest)
            extra = ""
            if dest.suffix == ".zip":
                extra = f" zip:{len(zipfile.ZipFile(dest).namelist())} file"
            elif dest.suffix == ".pdf":
                extra = f" halaman:{pymupdf.open(dest).page_count}"
            print(f"OK   {tool:18} {dest.name:32} {dest.stat().st_size:>8} B{extra} {res.info or ''} ({time.time() - t0:.1f}s)")
            ok += 1
        except UserError as e:
            print(f"USER {tool:18} {e}")
            fail += 1
        except Exception:  # noqa: BLE001
            print(f"ERR  {tool:18}\n{traceback.format_exc()}")
            fail += 1
    print(f"\n{ok} berhasil, {fail} gagal/ditolak — keluaran di {out_root}")


if __name__ == "__main__":
    os.environ.setdefault("HTML_ALLOW_PRIVATE", "0")
    main()
