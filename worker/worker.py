"""OlahPDF worker.

Mengambil job dari tabel `jobs` PostgreSQL (FOR UPDATE SKIP LOCKED), memprosesnya
di proses anak dengan batas waktu, lalu menulis hasilnya kembali ke database.
Proses utama juga membersihkan file kedaluwarsa dan memulihkan job yang macet.
"""
from __future__ import annotations

import json
import logging
import multiprocessing as mp
import os
import shutil
import signal
import sys
import time
import traceback
import uuid
from pathlib import Path

import psycopg
from psycopg.rows import dict_row

from olahpdf import PROCESSORS
from olahpdf.common import InputFile, UserError

DATABASE_URL = os.environ.get("DATABASE_URL", "postgresql://olahpdf:olahpdf@localhost:5432/olahpdf")
STORAGE = Path(os.environ.get("STORAGE_DIR", "/data")).resolve()
CONCURRENCY = max(1, int(os.environ.get("WORKER_CONCURRENCY", "2")))
JOB_TIMEOUT = int(os.environ.get("JOB_TIMEOUT", "300"))
POLL_INTERVAL = float(os.environ.get("POLL_INTERVAL", "1.0"))
CLEANUP_INTERVAL = int(os.environ.get("CLEANUP_INTERVAL", "120"))
RESULT_TTL_MIN = int(os.environ.get("RESULT_TTL_MINUTES", "60"))
ROW_RETENTION_DAYS = int(os.environ.get("ROW_RETENTION_DAYS", "30"))
MAX_ATTEMPTS = 2

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                    format="%(asctime)s %(processName)s %(levelname)s %(message)s")
log = logging.getLogger("worker")
_stopping = False  # diset oleh handler sinyal; sengaja tanpa lock agar aman di handler


def _within_storage(rel: str) -> Path:
    p = (STORAGE / rel).resolve()
    if STORAGE not in p.parents:
        raise UserError("Lokasi file tidak valid.")
    return p


def _run_job(job: dict, conn_out) -> None:
    """Dijalankan di proses anak. Mengirim hasil lewat pipe."""
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    try:
        fn = PROCESSORS.get(job["tool"])
        if fn is None:
            raise UserError(f"Tool '{job['tool']}' tidak dikenal.")
        inputs = [InputFile(field=f.get("field", "files"), name=f["name"], path=_within_storage(f["path"]),
                            size=int(f.get("size") or 0)) for f in job["input_files"]]
        out_dir = STORAGE / "outputs" / str(job["id"])
        out_dir.mkdir(parents=True, exist_ok=True)
        res = fn(inputs, job["options"] or {}, out_dir)
        final = out_dir / f"result{res.path.suffix}"
        res.path.replace(final)
        for leftover in out_dir.iterdir():  # buang file antara
            if leftover != final:
                shutil.rmtree(leftover, ignore_errors=True) if leftover.is_dir() else leftover.unlink(missing_ok=True)
        conn_out.send({"ok": True, "path": str(final.relative_to(STORAGE)), "name": res.name,
                       "size": final.stat().st_size, "info": res.info})
    except UserError as exc:
        conn_out.send({"ok": False, "user": True, "error": str(exc)})
    except Exception as exc:  # noqa: BLE001
        log.error("job %s gagal:\n%s", job["id"], traceback.format_exc())
        conn_out.send({"ok": False, "user": False, "error": f"{type(exc).__name__}: {exc}"})
    finally:
        conn_out.close()


def _claim(conn) -> dict | None:
    with conn.transaction():
        return conn.execute(
            """UPDATE jobs SET status='processing', started_at=now(), attempts=attempts+1
               WHERE id = (SELECT id FROM jobs WHERE status='queued'
                           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
               RETURNING id, tool, options, input_files, attempts""").fetchone()


def _finish(conn, job_id, *, ok: bool, payload: dict, requeue: bool = False) -> None:
    with conn.transaction():
        if ok:
            conn.execute(
                """UPDATE jobs SET status='done', output_path=%s, output_name=%s, output_size=%s,
                       result=%s, error=NULL, finished_at=now(),
                       expires_at=now() + make_interval(mins => %s)
                   WHERE id=%s""",
                (payload["path"], payload["name"], payload["size"], json.dumps(payload.get("info") or {}),
                 RESULT_TTL_MIN, job_id))
        elif requeue:
            conn.execute("UPDATE jobs SET status='queued', started_at=NULL WHERE id=%s", (job_id,))
        else:
            conn.execute(
                """UPDATE jobs SET status='failed', error=%s, finished_at=now(),
                       expires_at=now() + interval '10 minutes' WHERE id=%s""",
                (payload["error"][:1000], job_id))
    if ok or not requeue:  # file unggahan tidak diperlukan lagi
        shutil.rmtree(STORAGE / "uploads" / str(job_id), ignore_errors=True)
    if not ok:  # buang sisa file antara dari percobaan yang gagal
        shutil.rmtree(STORAGE / "outputs" / str(job_id), ignore_errors=True)


def worker_loop(n: int) -> None:
    mp.current_process().name = f"worker-{n}"
    ctx = mp.get_context("fork")
    conn = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)
    log.info("siap (timeout %ss)", JOB_TIMEOUT)
    while not _stopping:
        try:
            job = _claim(conn)
        except psycopg.OperationalError:
            log.warning("koneksi database terputus, mencoba lagi…")
            time.sleep(3)
            try:
                conn = psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)
            except psycopg.OperationalError:
                pass
            continue
        if not job:
            time.sleep(POLL_INTERVAL)
            continue
        t0 = time.monotonic()
        log.info("mulai %s [%s]", job["id"], job["tool"])
        recv, send = ctx.Pipe(duplex=False)
        proc = ctx.Process(target=_run_job, args=(job, send), name=f"job-{str(job['id'])[:8]}")
        proc.start()
        send.close()
        result = None
        if recv.poll(JOB_TIMEOUT):
            try:
                result = recv.recv()
            except EOFError:
                result = None
        proc.join(5)
        if proc.is_alive():
            proc.kill()
            proc.join()
            if result is None:
                result = {"ok": False, "user": True,
                          "error": f"Pemrosesan melebihi batas waktu ({JOB_TIMEOUT} detik). Coba file yang lebih kecil."}
        if result is None:  # proses anak mati mendadak (mis. kehabisan memori)
            retry = job["attempts"] < MAX_ATTEMPTS
            log.error("job %s: proses anak berhenti (exit %s), %s", job["id"], proc.exitcode,
                      "diulang" if retry else "gagal")
            _finish(conn, job["id"], ok=False, requeue=retry,
                    payload={"error": "Server kehabisan sumber daya saat memproses file ini."})
            continue
        if result["ok"]:
            _finish(conn, job["id"], ok=True, payload=result)
            log.info("selesai %s dalam %.1fs (%s B)", job["id"], time.monotonic() - t0, result["size"])
        else:
            msg = result["error"] if result.get("user") else "Terjadi kesalahan saat memproses file. Coba lagi atau gunakan file lain."
            _finish(conn, job["id"], ok=False, payload={"error": msg})
            log.info("gagal %s: %s", job["id"], result["error"])
    conn.close()


def maintenance(conn) -> None:
    with conn.transaction():
        expired = conn.execute(
            """UPDATE jobs SET status='expired', output_path=NULL
               WHERE expires_at < now() AND status IN ('done','failed','queued')
               RETURNING id""").fetchall()
        stale = conn.execute(
            """UPDATE jobs SET status = CASE WHEN attempts < %s THEN 'queued' ELSE 'failed' END,
                   error = CASE WHEN attempts < %s THEN NULL ELSE 'Pemrosesan terhenti. Silakan coba lagi.' END,
                   started_at = NULL
               WHERE status='processing' AND started_at < now() - make_interval(secs => %s)
               RETURNING id""", (MAX_ATTEMPTS, MAX_ATTEMPTS, JOB_TIMEOUT + 120)).fetchall()
        conn.execute("DELETE FROM jobs WHERE created_at < now() - make_interval(days => %s)",
                     (ROW_RETENTION_DAYS,))
    for row in expired:
        for sub in ("uploads", "outputs"):
            shutil.rmtree(STORAGE / sub / str(row["id"]), ignore_errors=True)
    # folder yatim (mis. unggahan gagal disimpan ke DB) yang lebih tua dari 1 hari
    cutoff = time.time() - 86400
    for sub in ("uploads", "outputs"):
        base = STORAGE / sub
        if base.is_dir():
            for d in base.iterdir():
                try:
                    if d.stat().st_mtime < cutoff:
                        uuid.UUID(d.name)
                        known = conn.execute("SELECT 1 FROM jobs WHERE id=%s AND status<>'expired'", (d.name,)).fetchone()
                        if not known:
                            shutil.rmtree(d, ignore_errors=True)
                except (ValueError, OSError):
                    continue
    if expired or stale:
        log.info("pembersihan: %d kedaluwarsa, %d job macet dipulihkan", len(expired), len(stale))


def main() -> None:
    for sub in ("uploads", "outputs"):
        (STORAGE / sub).mkdir(parents=True, exist_ok=True)

    def stop(*_):
        global _stopping  # noqa: PLW0603
        _stopping = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    procs = [mp.get_context("fork").Process(target=worker_loop, args=(i + 1,), name=f"worker-{i + 1}")
             for i in range(CONCURRENCY)]
    for p in procs:
        p.start()
    conn = None
    last = 0.0
    while not _stopping:
        if time.monotonic() - last > CLEANUP_INTERVAL:
            try:
                conn = conn or psycopg.connect(DATABASE_URL, autocommit=True, row_factory=dict_row)
                maintenance(conn)
            except psycopg.Error as exc:
                log.warning("pembersihan gagal: %s", exc)
                conn = None
            last = time.monotonic()
        for i, p in enumerate(procs):  # hidupkan lagi worker yang mati
            if not p.is_alive() and not _stopping:
                log.warning("worker-%d mati (exit %s), dijalankan ulang", i + 1, p.exitcode)
                procs[i] = mp.get_context("fork").Process(target=worker_loop, args=(i + 1,), name=f"worker-{i + 1}")
                procs[i].start()
        time.sleep(2)
    log.info("berhenti — menunggu job yang sedang berjalan selesai…")
    for p in procs:  # teruskan sinyal ke proses worker (docker hanya mengirim ke PID 1)
        if p.is_alive():
            os.kill(p.pid, signal.SIGTERM)
    for p in procs:
        p.join(JOB_TIMEOUT + 10)
    sys.exit(0)


if __name__ == "__main__":
    main()
