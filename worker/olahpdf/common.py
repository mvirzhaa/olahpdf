"""Utilitas bersama untuk semua processor."""
from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import pymupdf


class UserError(Exception):
    """Kesalahan yang pesannya aman & berguna untuk ditampilkan ke pengguna."""


@dataclass
class InputFile:
    field: str          # nama field form: "files", "watermark", "assets", "extra"
    name: str           # nama file asli dari pengguna
    path: Path          # lokasi file di disk
    size: int = 0

    @property
    def stem(self) -> str:
        return safe_stem(self.name)

    @property
    def ext(self) -> str:
        return Path(self.name).suffix.lower().lstrip(".")


@dataclass
class Result:
    path: Path                      # file keluaran
    name: str                       # nama unduhan
    info: dict = field(default_factory=dict)


SOFFICE = os.environ.get("SOFFICE_BIN", shutil.which("soffice") or "soffice")
GS = os.environ.get("GS_BIN", shutil.which("gs") or "gs")
OFFICE_TIMEOUT = int(os.environ.get("OFFICE_TIMEOUT", "180"))


def safe_stem(name: str, default: str = "dokumen") -> str:
    stem = Path(name or "").stem
    stem = re.sub(r"[^\w\-. ]+", "_", stem, flags=re.UNICODE).strip(" ._")
    return (stem or default)[:80]


def files_of(inputs: list[InputFile], field_name: str = "files") -> list[InputFile]:
    return [f for f in inputs if f.field == field_name]


def open_pdf(f: InputFile, password: str | None = None) -> pymupdf.Document:
    try:
        doc = pymupdf.open(f.path, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise UserError(f"File '{f.name}' bukan PDF yang valid atau rusak.") from exc
    if doc.needs_pass:
        if password and doc.authenticate(password):
            return doc
        raise UserError(
            f"File '{f.name}' dilindungi password. Buka dulu dengan alat 'Unlock PDF'."
            if not password else f"Password untuk '{f.name}' salah."
        )
    if doc.page_count == 0:
        raise UserError(f"File '{f.name}' tidak memiliki halaman.")
    return doc


def save_pdf(doc: pymupdf.Document, out: Path, *, compact: bool = True) -> Path:
    doc.save(out, garbage=3 if compact else 0, deflate=True, use_objstms=1 if compact else 0)
    return out


def parse_pages(spec: str | None, page_count: int) -> list[int]:
    """'1-3, 5, 8-' → daftar indeks halaman 0-based (urutan dijaga, tanpa duplikat).
    Spec kosong = semua halaman. Mendukung 'last'/'akhir' dan rentang terbuka '8-'."""
    spec = (spec or "").strip().lower()
    if not spec or spec in ("all", "semua"):
        return list(range(page_count))
    pages: list[int] = []
    seen: set[int] = set()
    for part in re.split(r"[,;\s]+", spec):
        if not part:
            continue
        part = part.replace("last", str(page_count)).replace("akhir", str(page_count))
        m = re.fullmatch(r"(\d*)-(\d*)", part)
        if m:
            a = int(m.group(1)) if m.group(1) else 1
            b = int(m.group(2)) if m.group(2) else page_count
            if a > b:
                a, b = b, a
            rng = range(a, b + 1)
        elif part.isdigit():
            rng = range(int(part), int(part) + 1)
        else:
            raise UserError(f"Format halaman '{part}' tidak dikenali. Contoh yang benar: 1-3, 5, 8-10")
        for p in rng:
            if p < 1 or p > page_count:
                raise UserError(f"Halaman {p} di luar jangkauan (dokumen punya {page_count} halaman).")
            if p - 1 not in seen:
                seen.add(p - 1)
                pages.append(p - 1)
    if not pages:
        raise UserError("Tidak ada halaman yang dipilih.")
    return pages


def parse_ranges(spec: str, page_count: int) -> list[list[int]]:
    """'1-3, 4-6, 9' → [[0,1,2],[3,4,5],[8]] — setiap bagian menjadi satu file."""
    groups = []
    for part in re.split(r"[,;]+", spec or ""):
        part = part.strip()
        if part:
            groups.append(parse_pages(part, page_count))
    if not groups:
        raise UserError("Isi rentang halaman, contoh: 1-3, 4-6, 9")
    return groups


def hex_to_rgb(value: str | None, default=(0, 0, 0)) -> tuple[float, float, float]:
    value = (value or "").strip().lstrip("#")
    if len(value) == 3:
        value = "".join(c * 2 for c in value)
    if not re.fullmatch(r"[0-9a-fA-F]{6}", value):
        return default
    return tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore[return-value]


def clamp(v, lo, hi, default):
    try:
        v = float(v)
    except (TypeError, ValueError):
        return default
    return max(lo, min(hi, v))


def make_zip(files: list[Path], out: Path, names: list[str] | None = None) -> Path:
    used: set[str] = set()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
        for i, p in enumerate(files):
            name = names[i] if names else p.name
            base, ext = os.path.splitext(name)
            n, k = name, 2
            while n.lower() in used:
                n = f"{base} ({k}){ext}"
                k += 1
            used.add(n.lower())
            zf.write(p, n)
    return out


def single_or_zip(paths: list[Path], names: list[str], out_dir: Path, zip_name: str, info: dict | None = None) -> Result:
    if not paths:
        raise UserError("Tidak ada file yang dihasilkan.")
    if len(paths) == 1:
        return Result(paths[0], names[0], info or {})
    z = make_zip(paths, out_dir / f"{uuid.uuid4().hex}.zip", names)
    return Result(z, zip_name, {**(info or {}), "files": len(paths)})


def run(cmd: list[str], timeout: int, what: str) -> subprocess.CompletedProcess:
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise UserError(f"Komponen '{cmd[0]}' belum terpasang di server ({what}).") from exc
    except subprocess.TimeoutExpired as exc:
        raise UserError(f"Proses {what} terlalu lama dan dihentikan.") from exc
    return proc


def soffice_convert(src: Path, out_dir: Path, target: str, infilter: str | None = None) -> Path:
    """Konversi dengan LibreOffice headless. Profil terpisah per proses supaya bisa paralel."""
    profile = Path(tempfile.mkdtemp(prefix="lo_profile_"))
    work = Path(tempfile.mkdtemp(prefix="lo_out_", dir=out_dir))
    try:
        cmd = [SOFFICE, f"-env:UserInstallation={profile.as_uri()}", "--headless", "--norestore",
               "--nolockcheck", "--nodefault", "--nofirststartwizard"]
        if infilter:
            cmd.append(f"--infilter={infilter}")
        cmd += ["--convert-to", target, "--outdir", str(work), str(src)]
        proc = run(cmd, OFFICE_TIMEOUT, "konversi LibreOffice")
        produced = [p for p in work.iterdir() if p.is_file()]
        if proc.returncode != 0 or not produced:
            raise UserError("LibreOffice gagal mengonversi file. Pastikan file tidak rusak atau terkunci password.")
        final = out_dir / f"{uuid.uuid4().hex}{produced[0].suffix}"
        produced[0].replace(final)
        return final
    finally:
        shutil.rmtree(profile, ignore_errors=True)
        shutil.rmtree(work, ignore_errors=True)
