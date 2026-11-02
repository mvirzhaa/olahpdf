"""Konversi ke PDF dan dari PDF."""
from __future__ import annotations

import io
import ipaddress
import logging
import os
import re
import socket
import uuid
from pathlib import Path
from urllib.parse import urlparse

import pymupdf
from PIL import Image, ImageOps

from .common import (GS, InputFile, Result, UserError, clamp, files_of, open_pdf, run,
                     safe_stem, single_or_zip, soffice_convert)

log = logging.getLogger(__name__)

PAGE_SIZES = {"a4": (595.28, 841.89), "letter": (612.0, 792.0), "legal": (612.0, 1008.0)}
MARGINS = {"none": 0, "small": 20, "big": 50}


# ─────────────────────────────── KE PDF ───────────────────────────────

def _image_bytes(f: InputFile) -> tuple[bytes, int, int]:
    """Baca gambar, perbaiki orientasi EXIF, kembalikan bytes siap disisipkan ke PDF."""
    try:
        with Image.open(f.path) as im:
            im.load()
            fmt = im.format
            needs_rotate = im.getexif().get(0x0112, 1) not in (1, None)
            rotated = ImageOps.exif_transpose(im) if needs_rotate else im
            # JPEG tanpa rotasi: pakai bytes asli supaya tidak terjadi kompresi ulang
            if fmt == "JPEG" and not needs_rotate and im.mode in ("RGB", "L", "CMYK"):
                return f.path.read_bytes(), im.width, im.height
            img = rotated
            if img.mode in ("RGBA", "LA", "P"):
                img = img.convert("RGBA")
                bg = Image.new("RGB", img.size, "white")
                bg.paste(img, mask=img.split()[-1])
                img = bg
            elif img.mode not in ("RGB", "L"):
                img = img.convert("RGB")
            buf = io.BytesIO()
            if fmt == "JPEG" or (img.width * img.height > 4_000_000):
                img.save(buf, "JPEG", quality=92, optimize=True)
            else:
                img.save(buf, "PNG", optimize=True)
            return buf.getvalue(), img.width, img.height
    except UserError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise UserError(f"Gambar '{f.name}' tidak dapat dibaca.") from exc


def _fit(img_w, img_h, box: pymupdf.Rect) -> pymupdf.Rect:
    scale = min(box.width / img_w, box.height / img_h)
    w, h = img_w * scale, img_h * scale
    x = box.x0 + (box.width - w) / 2
    y = box.y0 + (box.height - h) / 2
    return pymupdf.Rect(x, y, x + w, y + h)


def jpg_to_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    images = files_of(inputs)
    size = opts.get("pageSize", "fit")
    orient = opts.get("orientation", "auto")
    margin = MARGINS.get(opts.get("margin", "none"), 0)
    merge = opts.get("merge", True) is not False

    def add_page(doc, f):
        data, w, h = _image_bytes(f)
        if size == "fit":
            pw, ph = w * 0.75, h * 0.75  # 96 dpi → point
            factor = min(1.0, 14400 / max(pw + 2 * margin, ph + 2 * margin))
            pw, ph = pw * factor, ph * factor
            page = doc.new_page(width=pw + 2 * margin, height=ph + 2 * margin)
        else:
            pw, ph = PAGE_SIZES.get(size, PAGE_SIZES["a4"])
            landscape = orient == "landscape" or (orient == "auto" and w > h)
            if landscape:
                pw, ph = ph, pw
            page = doc.new_page(width=pw, height=ph)
        box = pymupdf.Rect(margin, margin, page.rect.width - margin, page.rect.height - margin)
        page.insert_image(_fit(w, h, box), stream=data)

    if merge:
        doc = pymupdf.open()
        for f in images:
            add_page(doc, f)
        out = out_dir / f"{uuid.uuid4().hex}.pdf"
        doc.save(out, garbage=3, deflate=True)
        name = f"{images[0].stem}.pdf" if len(images) == 1 else "gambar_ke_pdf.pdf"
        return Result(out, name, {"pages": doc.page_count})

    paths, names = [], []
    for f in images:
        doc = pymupdf.open()
        add_page(doc, f)
        out = out_dir / f"{uuid.uuid4().hex}.pdf"
        doc.save(out, garbage=3, deflate=True)
        paths.append(out)
        names.append(f"{f.stem}.pdf")
    return single_or_zip(paths, names, out_dir, "gambar_ke_pdf.zip")


def office_to_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    paths, names = [], []
    for f in files_of(inputs):
        pdf = soffice_convert(f.path, out_dir, "pdf")
        paths.append(pdf)
        names.append(f"{f.stem}.pdf")
    return single_or_zip(paths, names, out_dir, "hasil_konversi_pdf.zip")


# ─── HTML → PDF (Chromium via Playwright), dengan perlindungan SSRF ───

def _host_is_public(host: str) -> bool:
    if not host:
        return False
    if os.environ.get("HTML_ALLOW_PRIVATE", "0") == "1":
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0].split("%")[0])
        if (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
                or ip.is_reserved or ip.is_unspecified or not ip.is_global):
            return False
    return True


def _url_allowed(url: str) -> bool:
    u = urlparse(url)
    if u.scheme in ("data", "blob", "about"):
        return True
    if u.scheme not in ("http", "https"):
        return False
    return _host_is_public(u.hostname or "")


def html_to_pdf(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    from playwright.sync_api import Error as PWError
    from playwright.sync_api import sync_playwright

    mode = opts.get("source", "url")
    url = (opts.get("url") or "").strip()
    html_files = files_of(inputs)
    if mode == "url":
        if os.environ.get("HTML_URL_ENABLED", "1") != "1":
            raise UserError("Konversi dari URL dinonaktifkan oleh administrator.")
        if not re.match(r"^https?://", url, re.I):
            url = "https://" + url
        if not _url_allowed(url):
            raise UserError("URL tidak diizinkan. Hanya alamat web publik (http/https) yang dapat dikonversi.")
    elif not html_files:
        raise UserError("Unggah file .html atau isi URL.")

    size = opts.get("pageSize", "a4")
    landscape = opts.get("orientation") == "landscape"
    margin_pt = MARGINS.get(opts.get("margin", "small"), 20)
    out = out_dir / f"{uuid.uuid4().hex}.pdf"

    def guard(route):
        req_url = route.request.url
        if not _url_allowed(req_url):
            return route.abort("blockedbyclient")
        if req_url.startswith(("data:", "blob:", "about:")):
            return route.continue_()
        try:
            # Ambil sendiri tanpa mengikuti redirect, agar setiap lompatan redirect ikut diperiksa.
            resp = route.fetch(max_redirects=0, timeout=20000)
        except PWError:
            return route.abort("failed")
        loc = resp.headers.get("location")
        if 300 <= resp.status < 400 and loc:
            from urllib.parse import urljoin
            if not _url_allowed(urljoin(req_url, loc)):
                return route.abort("blockedbyclient")
        return route.fulfill(response=resp)

    launch_args = {"args": ["--no-sandbox", "--disable-dev-shm-usage"], "headless": True}
    if os.environ.get("CHROME_PATH"):
        launch_args["executable_path"] = os.environ["CHROME_PATH"]
    with sync_playwright() as pw:
        browser = pw.chromium.launch(**launch_args)
        try:
            ctx = browser.new_context(service_workers="block", viewport={"width": 1280, "height": 900},
                                      java_script_enabled=True, accept_downloads=False)
            page = ctx.new_page()
            page.route("**/*", guard)
            page.set_default_timeout(45000)
            try:
                if mode == "url":
                    resp = page.goto(url, wait_until="load")
                    if resp is not None and resp.status >= 400:
                        raise UserError(f"Halaman web mengembalikan status {resp.status}.")
                else:
                    html = html_files[0].path.read_text(encoding="utf-8", errors="replace")
                    page.set_content(html, wait_until="load")
                try:
                    page.wait_for_load_state("networkidle", timeout=8000)
                except PWError:
                    pass
            except PWError as exc:
                raise UserError("Halaman web tidak dapat dibuka. Periksa alamat URL-nya.") from exc
            w, h = PAGE_SIZES.get(size, PAGE_SIZES["a4"])
            page.emulate_media(media="screen")
            page.pdf(path=str(out), width=f"{w / 72:.3f}in", height=f"{h / 72:.3f}in", landscape=landscape,
                     print_background=True,
                     margin={k: f"{margin_pt / 72:.3f}in" for k in ("top", "right", "bottom", "left")})
        finally:
            browser.close()

    if mode == "url":
        host = urlparse(url).hostname or "halaman"
        name = f"{safe_stem(host.replace('.', '_'))}.pdf"
    else:
        name = f"{html_files[0].stem}.pdf"
    return Result(out, name)


# ─────────────────────────────── DARI PDF ───────────────────────────────

def pdf_to_jpg(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    mode = opts.get("mode", "pages")
    dpi = int(clamp(opts.get("dpi"), 50, 300, 150))
    quality = int(clamp(opts.get("quality"), 40, 95, 85))
    paths, names = [], []
    for f in files_of(inputs):
        doc = open_pdf(f)
        if mode == "extract":
            seen = set()
            for pno, page in enumerate(doc):
                for img in page.get_images(full=True):
                    xref = img[0]
                    if xref in seen:
                        continue
                    seen.add(xref)
                    try:
                        pix = pymupdf.Pixmap(doc, xref)
                        if pix.width < 16 or pix.height < 16:
                            continue
                        if pix.alpha or pix.colorspace is None or pix.colorspace.n not in (1, 3):
                            pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                        data = pix.tobytes("jpg", jpg_quality=quality)
                    except Exception:  # noqa: BLE001
                        log.warning("gagal ekstrak gambar xref=%s", xref)
                        continue
                    p = out_dir / f"{uuid.uuid4().hex}.jpg"
                    p.write_bytes(data)
                    paths.append(p)
                    names.append(f"{f.stem}_hal{pno + 1}_gambar{len(seen)}.jpg")
        else:
            for pno, page in enumerate(doc):
                pix = page.get_pixmap(dpi=dpi, alpha=False)
                p = out_dir / f"{uuid.uuid4().hex}.jpg"
                p.write_bytes(pix.tobytes("jpg", jpg_quality=quality))
                paths.append(p)
                names.append(f"{f.stem}_halaman-{pno + 1}.jpg")
    if not paths:
        raise UserError("Tidak ditemukan gambar di dalam PDF." if mode == "extract" else "Tidak ada halaman yang dikonversi.")
    return single_or_zip(paths, names, out_dir, "pdf_ke_jpg.zip", {"images": len(paths)})


def pdf_to_word(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    from pdf2docx import Converter
    logging.getLogger("pdf2docx").setLevel(logging.WARNING)
    paths, names = [], []
    for f in files_of(inputs):
        doc = open_pdf(f)
        has_text = any(page.get_text("text").strip() for page in doc)
        doc.close()
        out = out_dir / f"{uuid.uuid4().hex}.docx"
        cv = Converter(str(f.path))
        try:
            cv.convert(str(out), multi_processing=False)
        except Exception as exc:  # noqa: BLE001
            raise UserError(f"Gagal mengonversi '{f.name}' ke Word.") from exc
        finally:
            cv.close()
        paths.append(out)
        names.append(f"{f.stem}.docx")
        if not has_text:
            log.info("PDF %s tampaknya hasil scan (tanpa teks)", f.name)
    return single_or_zip(paths, names, out_dir, "pdf_ke_word.zip")


def pdf_to_ppt(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    mode = opts.get("mode", "image")
    paths, names = [], []
    for f in files_of(inputs):
        doc = open_pdf(f)
        if mode == "editable":
            doc.close()
            out = soffice_convert(f.path, out_dir, "pptx", infilter="impress_pdf_import")
        else:
            out = _pdf_to_ppt_images(doc, out_dir)
        paths.append(out)
        names.append(f"{f.stem}.pptx")
    return single_or_zip(paths, names, out_dir, "pdf_ke_powerpoint.zip")


def _pdf_to_ppt_images(doc: pymupdf.Document, out_dir: Path) -> Path:
    from pptx import Presentation
    from pptx.util import Emu

    first = doc[0].rect
    emu_per_pt = 12700
    max_emu = 51206400  # batas PowerPoint (56 inci)
    scale = min(1.0, max_emu / (max(first.width, first.height) * emu_per_pt))
    sw, sh = int(first.width * emu_per_pt * scale), int(first.height * emu_per_pt * scale)
    prs = Presentation()
    prs.slide_width, prs.slide_height = Emu(sw), Emu(sh)
    blank = prs.slide_layouts[6]
    for page in doc:
        pix = page.get_pixmap(dpi=150, alpha=False)
        stream = io.BytesIO(pix.tobytes("jpg", jpg_quality=88))
        slide = prs.slides.add_slide(blank)
        r = min(sw / pix.width, sh / pix.height)
        w, h = int(pix.width * r), int(pix.height * r)
        slide.shapes.add_picture(stream, Emu((sw - w) // 2), Emu((sh - h) // 2), Emu(w), Emu(h))
        text = page.get_text("text").strip()
        if text:  # simpan teks halaman di catatan pembicara agar tetap dapat dicari/disalin
            slide.notes_slide.notes_text_frame.text = text[:20000]
    out = out_dir / f"{uuid.uuid4().hex}.pptx"
    prs.save(out)
    return out


_NUM_ID = re.compile(r"^-?\d{1,3}(\.\d{3})+(,\d+)?$")    # 1.234.567,89
_NUM_EN = re.compile(r"^-?\d{1,3}(,\d{3})+(\.\d+)?$")    # 1,234,567.89
_NUM_PLAIN = re.compile(r"^-?\d+([.,]\d+)?$")


def _cell_value(v):
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    try:
        if _NUM_ID.match(s):
            return float(s.replace(".", "").replace(",", "."))
        if _NUM_EN.match(s):
            return float(s.replace(",", ""))
        if _NUM_PLAIN.match(s) and not (len(s) > 1 and s.lstrip("-").startswith("0") and "." not in s and "," not in s):
            n = float(s.replace(",", "."))
            return int(n) if n.is_integer() and "." not in s and "," not in s else n
    except ValueError:
        pass
    return s


def pdf_to_excel(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    import pdfplumber
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    from openpyxl.utils import get_column_letter

    layout = opts.get("layout", "per-page")
    include_text = opts.get("includeText", True) is not False
    paths, names = [], []
    for f in files_of(inputs):
        open_pdf(f).close()  # validasi & cek password
        wb = Workbook()
        wb.remove(wb.active)
        single = wb.create_sheet("Data") if layout == "single" else None
        found = 0
        head_font = Font(bold=True, color="FFFFFF")
        head_fill = PatternFill("solid", fgColor="2F5597")
        with pdfplumber.open(f.path) as pdf:
            for pno, page in enumerate(pdf.pages, start=1):
                tables = page.extract_tables() or []
                ws = single or wb.create_sheet(f"Hal {pno}")
                row = ws.max_row + 2 if single and ws.max_row > 1 else 1
                if tables:
                    for tno, table in enumerate(tables, start=1):
                        if single:
                            ws.cell(row=row, column=1, value=f"Halaman {pno} — Tabel {tno}").font = Font(bold=True)
                            row += 1
                        for rno, trow in enumerate(table):
                            for cno, v in enumerate(trow, start=1):
                                c = ws.cell(row=row, column=cno, value=_cell_value(v) if rno else (v or "").strip() or None)
                                if rno == 0:
                                    c.font, c.fill = head_font, head_fill
                            row += 1
                        row += 1
                        found += 1
                elif include_text:
                    text = page.extract_text() or ""
                    if text.strip():
                        if single:
                            ws.cell(row=row, column=1, value=f"Halaman {pno} (teks)").font = Font(bold=True)
                            row += 1
                        for line in text.splitlines():
                            cols = re.split(r"\s{2,}", line.strip())
                            for cno, v in enumerate(cols, start=1):
                                ws.cell(row=row, column=cno, value=_cell_value(v))
                            row += 1
                        found += 1
                if not single and ws.max_row == 1 and ws.cell(1, 1).value is None:
                    wb.remove(ws)
        if not found:
            raise UserError(f"Tidak ditemukan tabel atau teks pada '{f.name}'. Jika PDF hasil scan, teks tidak dapat dibaca.")
        for ws in wb.worksheets:
            for col in ws.columns:
                width = max((len(str(c.value)) for c in col if c.value is not None), default=8)
                ws.column_dimensions[get_column_letter(col[0].column)].width = min(60, max(8, width + 2))
        out = out_dir / f"{uuid.uuid4().hex}.xlsx"
        wb.save(out)
        paths.append(out)
        names.append(f"{f.stem}.xlsx")
    return single_or_zip(paths, names, out_dir, "pdf_ke_excel.zip")


def _find_srgb_icc() -> str | None:
    import glob
    cands = [os.environ.get("SRGB_ICC", "")]
    cands += glob.glob("/usr/share/ghostscript/*/iccprofiles/srgb.icc")
    cands += ["/usr/share/color/icc/ghostscript/srgb.icc", "/usr/share/color/icc/sRGB.icc",
              "/usr/share/color/icc/colord/sRGB.icc"]
    return next((c for c in cands if c and os.path.isfile(c)), None)


def pdf_to_pdfa(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    level = opts.get("level", "2b")
    part = {"1b": "1", "2b": "2", "3b": "3"}.get(level, "2")
    icc = _find_srgb_icc()
    if not icc:
        raise UserError("Profil warna sRGB (srgb.icc) tidak ditemukan di server. Pasang paket ghostscript.")
    paths, names = [], []
    for f in files_of(inputs):
        open_pdf(f).close()
        def_ps = out_dir / f"{uuid.uuid4().hex}_pdfa_def.ps"
        esc_icc = icc.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
        def_ps.write_text(
            "%!\n"
            f"/ICCProfile ({esc_icc}) def\n"
            "[/_objdef {icc_PDFA} /type /stream /OBJ pdfmark\n"
            "[{icc_PDFA} <</N 3>> /PUT pdfmark\n"
            "[{icc_PDFA} ICCProfile (r) file /PUT pdfmark\n"
            "[/_objdef {OutputIntent_PDFA} /type /dict /OBJ pdfmark\n"
            "[{OutputIntent_PDFA} <<\n  /Type /OutputIntent\n  /S /GTS_PDFA1\n"
            "  /DestOutputProfile {icc_PDFA}\n  /OutputConditionIdentifier (sRGB)\n"
            "  /Info (sRGB IEC61966-2.1)\n>> /PUT pdfmark\n"
            "[{Catalog} <</OutputIntents [ {OutputIntent_PDFA} ]>> /PUT pdfmark\n",
            encoding="ascii")
        out = out_dir / f"{uuid.uuid4().hex}.pdf"
        cmd = [GS, f"-dPDFA={part}", "-dBATCH", "-dNOPAUSE", "-dNOOUTERSAVE", "-dSAFER",
               f"--permit-file-read={icc}", "-sColorConversionStrategy=RGB",
               "-sProcessColorModel=DeviceRGB", "-dPDFACompatibilityPolicy=1",
               "-sDEVICE=pdfwrite", f"-sOutputICCProfile={icc}", f"-sOutputFile={out}",
               str(def_ps), str(f.path)]
        proc = run(cmd, 300, "konversi PDF/A (Ghostscript)")
        def_ps.unlink(missing_ok=True)
        if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            log.error("gs gagal: %s", proc.stderr.decode(errors="replace")[-2000:])
            raise UserError(f"Gagal mengonversi '{f.name}' ke PDF/A.")
        paths.append(out)
        names.append(f"{f.stem}_PDFA-{level}.pdf")
    return single_or_zip(paths, names, out_dir, "pdf_ke_pdfa.zip", {"level": f"PDF/A-{level}"})
