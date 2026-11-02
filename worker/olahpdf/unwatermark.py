"""Hapus watermark dari PDF.

Yang dapat dihapus otomatis (watermark yang masih berupa objek terpisah):
1. Anotasi bertipe /Watermark.
2. Konten bertanda artefak watermark (/Artifact <</Subtype /Watermark>>) — dipakai Acrobat,
   Microsoft Word, LibreOffice, dan banyak aplikasi lain saat menambahkan watermark.
3. Konten di layer (Optional Content Group) yang namanya mengandung "watermark"/"tanda air",
   termasuk watermark yang dibuat oleh OlahPDF sendiri.
4. Teks tertentu yang disebutkan pengguna (mis. "DRAFT"), dihapus dengan redaksi.

Watermark yang sudah menyatu ke gambar hasil scan tidak dapat dipisahkan secara otomatis.
"""
from __future__ import annotations

import uuid
from pathlib import Path

import pikepdf
import pymupdf

from .common import InputFile, Result, UserError, files_of, open_pdf, single_or_zip

WM_WORDS = ("watermark", "tanda air", "wasserzeichen", "filigrane", "marca de agua")


def _is_wm_ocg(oc) -> bool:
    try:
        if oc is None:
            return False
        if oc.get("/Type") == "/OCMD":
            ocgs = oc.get("/OCGs")
            if ocgs is None:
                return False
            ocgs = ocgs if isinstance(ocgs, pikepdf.Array) else [ocgs]
            return any(_is_wm_ocg(g) for g in ocgs)
        name = str(oc.get("/Name", "")).lower()
        return any(w in name for w in WM_WORDS)
    except Exception:  # noqa: BLE001
        return False


def _is_wm_props(props) -> bool:
    try:
        if props is None:
            return False
        if props.get("/Subtype") == "/Watermark":
            return True
        if props.get("/Type") in ("/OCG", "/OCMD"):
            return _is_wm_ocg(props)
    except Exception:  # noqa: BLE001
        return False
    return False


class _Cleaner:
    def __init__(self):
        self.removed = 0
        self.seen: set[tuple[int, int]] = set()

    def _resolve_props(self, operand, resources):
        if isinstance(operand, pikepdf.Dictionary):
            return operand
        if isinstance(operand, pikepdf.Name) and resources is not None:
            props = resources.get("/Properties")
            if props is not None:
                return props.get(operand)
        return None

    def filter_ops(self, ops, resources):
        out = []
        skip = 0
        xobjects = resources.get("/XObject") if resources is not None else None
        for operands, op in ops:
            name = str(op)
            if skip:
                if name in ("BDC", "BMC"):
                    skip += 1
                elif name == "EMC":
                    skip -= 1
                continue
            if name == "BDC" and len(operands) == 2 and str(operands[0]) in ("/Artifact", "/OC"):
                if _is_wm_props(self._resolve_props(operands[1], resources)):
                    skip = 1
                    self.removed += 1
                    continue
            if name == "Do" and xobjects is not None:
                xo = xobjects.get(operands[0])
                if xo is not None and _is_wm_ocg(xo.get("/OC")):
                    self.removed += 1
                    continue
            out.append((operands, op))
        return out

    def clean_xobjects(self, resources, pdf):
        if resources is None:
            return
        xobjects = resources.get("/XObject")
        if xobjects is None:
            return
        for _, xo in xobjects.items():
            try:
                if xo.get("/Subtype") != "/Form" or not xo.is_indirect:
                    continue
                key = xo.objgen
                if key in self.seen:
                    continue
                self.seen.add(key)
                res = xo.get("/Resources") or resources
                before = self.removed
                ops = pikepdf.parse_content_stream(xo)
                new_ops = self.filter_ops(ops, res)
                if self.removed != before:
                    xo.write(pikepdf.unparse_content_stream(new_ops))
                self.clean_xobjects(res, pdf)
            except pikepdf.PdfError:
                continue

    def clean_page(self, page: pikepdf.Page, pdf: pikepdf.Pdf):
        res = page.obj.get("/Resources")
        before = self.removed
        ops = pikepdf.parse_content_stream(page)
        new_ops = self.filter_ops(ops, res)
        if self.removed != before:
            page.obj.Contents = pdf.make_stream(pikepdf.unparse_content_stream(new_ops))
        self.clean_xobjects(res, pdf)
        annots = page.obj.get("/Annots")
        if annots is not None:
            keep = [a for a in annots if a.get("/Subtype") != "/Watermark"]
            if len(keep) != len(annots):
                self.removed += len(annots) - len(keep)
                page.obj.Annots = pdf.make_indirect(pikepdf.Array(keep))


def _drop_wm_ocgs(pdf: pikepdf.Pdf) -> None:
    props = pdf.Root.get("/OCProperties")
    if props is None:
        return
    ocgs = props.get("/OCGs")
    if ocgs is None:
        return
    wm = {g.objgen for g in ocgs if _is_wm_ocg(g)}
    if not wm:
        return

    def prune(arr):
        out = pikepdf.Array()
        for x in arr:
            if isinstance(x, pikepdf.Array):
                out.append(prune(x))
            elif not (hasattr(x, "objgen") and x.objgen in wm):
                out.append(x)
        return out

    props.OCGs = prune(ocgs)
    d = props.get("/D")
    if d is not None:
        for key in ("/Order", "/ON", "/OFF", "/Locked", "/AS"):
            if key in d and isinstance(d[key], pikepdf.Array):
                d[key] = prune(d[key])


def _remove_text(path: Path, text: str, out: Path) -> int:
    doc = pymupdf.open(path)
    hits = 0
    for page in doc:
        if page.rotation:
            page.remove_rotation()
        quads = page.search_for(text, quads=True)
        for q in quads:
            page.add_redact_annot(q, fill=False, cross_out=False)
        if quads:
            hits += len(quads)
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE,
                                  graphics=pymupdf.PDF_REDACT_LINE_ART_NONE,
                                  text=pymupdf.PDF_REDACT_TEXT_REMOVE)
    doc.save(out, garbage=4, deflate=True, use_objstms=1)
    return hits


def remove_watermark(inputs: list[InputFile], opts: dict, out_dir: Path) -> Result:
    text = (opts.get("text") or "").strip()
    paths, names = [], []
    total = {"structural": 0, "text": 0}
    for f in files_of(inputs):
        open_pdf(f).close()  # validasi & tolak PDF berpassword dengan pesan yang jelas
        stage1 = out_dir / f"{uuid.uuid4().hex}.pdf"
        cleaner = _Cleaner()
        with pikepdf.open(f.path) as pdf:
            for page in pdf.pages:
                cleaner.clean_page(page, pdf)
            if cleaner.removed:
                _drop_wm_ocgs(pdf)
            pdf.remove_unreferenced_resources()
            pdf.save(stage1, compress_streams=True, object_stream_mode=pikepdf.ObjectStreamMode.generate)
        total["structural"] += cleaner.removed
        final = stage1
        if text:
            final = out_dir / f"{uuid.uuid4().hex}.pdf"
            total["text"] += _remove_text(stage1, text, final)
        paths.append(final)
        names.append(f"{f.stem}_tanpa_watermark.pdf")
    if not total["structural"] and not total["text"]:
        hint = (f'Teks "{text}" tidak ditemukan sebagai teks yang dapat dihapus. ' if text else "")
        raise UserError(
            hint + "Tidak ditemukan watermark yang dapat dihapus otomatis. Watermark ini kemungkinan sudah menyatu "
            "dengan isi halaman (misalnya hasil scan). Coba isi teks watermark-nya, atau gunakan Edit PDF → "
            "alat Tutup untuk menutup area tersebut.")
    return single_or_zip(paths, names, out_dir, "pdf_tanpa_watermark.zip",
                         {"removed_objects": total["structural"], "removed_text": total["text"]})
