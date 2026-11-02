# OlahPDF

Aplikasi web pengolah PDF yang dipasang di server sendiri (self-hosted). File tidak dikirim ke layanan pihak ketiga dan dihapus otomatis setelah 60 menit.

| Kelompok | Alat |
|---|---|
| Konversi ke PDF | JPG/PNG → PDF, Word → PDF, PowerPoint → PDF, Excel → PDF, HTML/URL → PDF |
| Konversi dari PDF | PDF → JPG, PDF → Word, PDF → PowerPoint, PDF → Excel, PDF → PDF/A, **PDF → Flipbook (HTML)** |
| Atur PDF | Gabung (merge), Pisah (split), Kompres |
| Edit & keamanan | Edit PDF, Watermark, Hapus watermark, Unlock |

## Arsitektur

```
Browser ──HTTP──▶ api (Node.js / Express)  ──INSERT job──▶ PostgreSQL (tabel jobs = antrean)
   ▲  unggah, cek status, unduh      │                         ▲
   │                                 │ simpan file             │ SELECT … FOR UPDATE SKIP LOCKED
   │                                 ▼                         │
   └──── unduh hasil ◀──────── volume /data ◀──────── worker (Python: PyMuPDF, pikepdf,
                                (uploads/, outputs/)            LibreOffice, Ghostscript, Chromium)
```

- **api/** — Express 5: validasi (ekstensi + tanda tangan isi file), rate limit, CSP via helmet, antarmuka web (vanilla JS, tanpa build step). pdf.js disajikan dari `node_modules`, jadi aplikasi tetap jalan di intranet tanpa CDN.
- **worker/** — mengambil job dari PostgreSQL, menjalankan setiap job di proses anak dengan batas waktu (`JOB_TIMEOUT`), memulihkan job macet, dan menghapus file kedaluwarsa.
- **db/init.sql** — skema tabel `jobs` dan view statistik `job_stats_daily`.

| Alat | Mesin |
|---|---|
| Office → PDF, PDF → PPTX (mode bisa diedit) | LibreOffice headless (profil terpisah per proses agar bisa paralel) |
| HTML/URL → PDF | Chromium (Playwright), dengan perlindungan SSRF: alamat privat/localhost diblokir, setiap redirect & sub-request diperiksa |
| PDF → Word | pdf2docx |
| PDF → Excel | pdfplumber + openpyxl (angka format Indonesia `1.234,56` dikenali) |
| PDF → PDF/A | Ghostscript dengan OutputIntent sRGB |
| Merge, split, kompres, watermark, edit, PDF → JPG/PPTX | PyMuPDF |
| Unlock, hapus watermark | pikepdf (+ PyMuPDF untuk redaksi teks) |
| PDF → Flipbook | PyMuPDF + Pillow (halaman WebP) + [StPageFlip](https://github.com/Nodlik/StPageFlip) (MIT, disertakan di `worker/olahpdf/assets/`) |

## Menjalankan dengan Docker (disarankan)

```bash
cp .env.example .env          # ganti POSTGRES_PASSWORD
docker compose up -d --build
# buka http://localhost:3000
```

Menambah kapasitas pemrosesan: naikkan `WORKER_CONCURRENCY`, atau jalankan beberapa container worker
(`docker compose up -d --scale worker=3`). Antrean berbasis `SKIP LOCKED` aman untuk banyak worker.

Uji asap semua alat di dalam container worker:

```bash
docker compose run --rm worker python -m tests.smoke_test /tmp/smoke
```

### Di belakang nginx

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_set_header   Host $host;
    proxy_set_header   X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    client_max_body_size 300m;      # samakan dengan MAX_TOTAL_MB
    proxy_request_buffering off;
    proxy_read_timeout 300s;
}
```

Jika nginx berada di host lain, atur `TRUST_PROXY` ke alamat IP-nya agar rate limit membaca IP klien yang benar.

## Menjalankan tanpa Docker (pengembangan)

Prasyarat: Node.js ≥ 20, Python ≥ 3.11, PostgreSQL ≥ 14, LibreOffice, Ghostscript.

```bash
# database
createuser -P olahpdf && createdb -O olahpdf olahpdf

# api
cd api && npm install
DATABASE_URL=postgresql://olahpdf:PASS@localhost/olahpdf STORAGE_DIR=../data npm run dev

# worker (terminal lain)
cd worker && python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt && playwright install chromium
DATABASE_URL=postgresql://olahpdf:PASS@localhost/olahpdf STORAGE_DIR=../data python worker.py
```

API dan worker **harus memakai folder `STORAGE_DIR` yang sama**.

## Konfigurasi

| Variabel | Default | Keterangan |
|---|---|---|
| `DATABASE_URL` | – | Koneksi PostgreSQL (api & worker) |
| `STORAGE_DIR` | `/data` | Folder bersama untuk unggahan & hasil |
| `MAX_FILE_MB` / `MAX_TOTAL_MB` | 100 / 300 | Batas ukuran per file / per job |
| `JOBS_PER_MINUTE` | 30 | Batas pembuatan job per IP per menit |
| `RESULT_TTL_MINUTES` | 60 | Lama file hasil disimpan |
| `WORKER_CONCURRENCY` | 2 | Jumlah job paralel per container worker |
| `JOB_TIMEOUT` | 300 | Batas waktu satu job (detik) |
| `HTML_URL_ENABLED` | 1 | Izinkan konversi dari URL |
| `HTML_ALLOW_PRIVATE` | 0 | Izinkan URL intranet/localhost (hati-hati: SSRF) |
| `ADMIN_TOKEN` | kosong | Aktifkan `GET /api/stats` dengan `Authorization: Bearer <token>` |
| `SSO_ENABLED` | 1 | Aktifkan proteksi E-Portal SSO (0 = bypass untuk dev offline) |
| `SSO_BASE_URL` | – | Base URL API E-Portal untuk introspeksi (`http://eportal.uika-bogor.ac.id/eportal-api`) |
| `EPORTAL_URL` | – | URL Frontend E-Portal UIKA (`http://eportal.uika-bogor.ac.id`) |
| `SSO_CLIENT_ID` | – | Client ID SSO dari modul E-Portal |
| `SSO_CLIENT_SECRET` | – | Client Secret SSO dari modul E-Portal |
| `SSO_APP_MODULE_ID` | – | ID Modul aplikasi di E-Portal |
| `SESSION_SECRET` | – | Kunci HMAC rahasia penandatangan cookie sesi pengguna |

## Integrasi E-Portal UIKA SSO

Aplikasi ini diproteksi secara penuh sehingga **hanya dapat diakses melalui E-Portal UIKA**:

1. Pengguna membuka E-Portal UIKA dan memilih modul **PDF Editor UIKA**.
2. E-Portal mengalihkan pengguna ke:
   `https://pdf.uika-bogor.ac.id/?token=<scoped_token>&role_id=<id>&appModule_id=<id>`
3. Backend OlahPDF memverifikasi keaslian token melalui `POST /sso/introspect` ke API E-Portal dengan header `X-SSO-Client-ID` dan `X-SSO-Client-Secret`.
4. Jika valid, sesi HTTP-only cookie (`uika_pdf_session`) dibuat dan URL dibersihkan secara otomatis.
5. Jika pengguna mengakses URL aplikasi secara langsung tanpa sesi aktif, layar restriksi UIKA akan ditampilkan dengan tombol pengalihan langsung ke E-Portal.

## Panduan Deploy ke Server (pdf.uika-bogor.ac.id)

1. Unggah berkas ke server:
   ```powershell
   .\deploy\upload-to-server.ps1
   ```
2. Hubungkan ke server via SSH:
   ```bash
   ssh -p 1961 root@103.158.196.137
   ```
3. Masuk ke direktori dan jalankan setup otomatis:
   ```bash
   cd /opt/olahpdf
   bash deploy/setup-server.sh
   ```
   *Script akan otomatis menginstal Docker, Nginx, Certbot SSL Let's Encrypt, dan menjalankan container.*

## API

| Metode | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/tools` | Daftar alat beserta definisi opsinya |
| `POST` | `/api/jobs/:tool` | `multipart/form-data`: `files` (bisa banyak), `options` (JSON), `watermark`, `extra`, `assets` → `{ id }` |
| `GET` | `/api/jobs/:id` | Status: `queued` / `processing` / `done` / `failed` / `expired` + posisi antrean |
| `GET` | `/api/jobs/:id/download` | Unduh hasil (`?inline=1` untuk pratinjau PDF) |
| `DELETE` | `/api/jobs/:id` | Hapus file dari server sekarang |
| `GET` | `/api/stats` | Statistik 30 hari (butuh `ADMIN_TOKEN`) |

Contoh dengan curl:

```bash
curl -F files=@a.pdf -F files=@b.pdf -F 'options={"bookmarks":true}' http://localhost:3000/api/jobs/merge
curl http://localhost:3000/api/jobs/<id>
curl -OJ http://localhost:3000/api/jobs/<id>/download
```

## Editor PDF

Seluruh pengeditan disusun di peramban dengan pdf.js, lalu diterapkan sekaligus di server saat **Simpan PDF**.

- **Halaman:** urutkan dengan seret, putar kiri/kanan, duplikat, hapus, sisip halaman kosong, sisip halaman dari PDF lain. Urungkan/ulangi (Ctrl+Z / Ctrl+Y).
- **Edit teks:** klik teks asli lalu ketik pengganti. Teks lama dihapus sungguhan dengan redaksi (bukan sekadar ditutup kotak putih); warna, ukuran, dan jenis huruf asli dipakai kecuali diubah.
- **Tambah:** teks, gambar/logo/tanda tangan, kotak, elips, garis, coretan bebas, stabilo (anotasi highlight), dan *Tutup* (whiteout).
- Pintasan: V pilih, E edit teks, T teks, I gambar, R kotak, O elips, L garis, D coret, H stabilo, W tutup, Delete hapus objek, panah untuk menggeser.

Format data yang dikirim editor didokumentasikan di `worker/olahpdf/edit.py`.

## PDF ke Flipbook

Mengubah PDF menjadi buku digital HTML yang bisa dibuka di peramban mana pun, tanpa internet dan tanpa server.

**Saat membuat** (di OlahPDF): judul, kualitas halaman (ringkas/standar/tinggi), sampul tebal untuk halaman pertama & terakhir, warna latar, suara kertas, dan **musik latar MP3** (opsional) beserta opsi putar otomatis, ulangi, dan volume. Hasil bisa berupa **satu file `.html`** (gambar & musik disematkan, mudah dibagikan lewat WhatsApp/email/LMS) atau **ZIP** (`index.html` + `halaman/` + `thumb/` + `audio/`) untuk diunggah ke hosting.

**Saat dibaca** (file HTML hasil):
- Halaman dibalik dengan efek kertas melengkung: klik/ketuk, seret sudut halaman, atau geser (swipe) di layar sentuh. Sampul berupa halaman tebal.
- Navigasi: tombol & panah keyboard, penggeser halaman dengan pratinjau, daftar halaman (thumbnail), dan **daftar isi** otomatis dari bookmark PDF.
- **Penanda halaman**: klik pita di tepi atas halaman atau ikon pita di bilah bawah (tombol B). Daftar penanda ada di panel; tersimpan di peramban pembaca (localStorage) dan tetap ada walau file dibuat ulang dari PDF yang sama.
- **Musik on/off** (tombol ♪ atau M), pilihan pembaca diingat. Peramban hanya mengizinkan suara setelah interaksi pertama, jadi musik "putar otomatis" mulai saat pembaca pertama kali menyentuh/klik halaman. Musik berhenti sendiri saat tab disembunyikan.
- Suara balik kertas (disintesis Web Audio, tanpa file tambahan) yang bisa dimatikan, layar penuh, perbesar halaman, tautan langsung ke halaman (`#hal-12`), dan tawaran "lanjutkan dari halaman terakhir".
- Responsif: dua halaman berdampingan di laptop/tablet mendatar, satu halaman di HP dan tablet tegak (dipilih otomatis berdasarkan ruang layar).

Tombol **Buka flipbook** di halaman hasil membuka pratinjau dengan header `Content-Security-Policy: sandbox`, sehingga halaman itu berjalan terisolasi dari aplikasi.

## Hapus watermark

Menghapus watermark yang masih berupa objek terpisah: anotasi watermark, konten bertanda artefak watermark (dipakai Acrobat, Word, LibreOffice), layer bernama "watermark", dan watermark yang dibuat OlahPDF sendiri (selalu diletakkan di layer tersendiri). Pengguna juga bisa menyebut teks tertentu (mis. `DRAFT`) untuk dihapus dengan redaksi. Watermark yang sudah menyatu dengan gambar hasil scan tidak bisa dipisahkan otomatis — gunakan alat *Tutup* di editor. Antarmuka menampilkan catatan agar alat ini dipakai pada dokumen yang pengguna berhak ubah.

## Keamanan & privasi

- File disimpan dengan nama acak (UUID), path diperiksa agar tidak keluar dari `STORAGE_DIR`.
- Isi file dicek dari *magic bytes*, bukan hanya ekstensi.
- File unggahan dihapus begitu job selesai; file hasil dihapus setelah `RESULT_TTL_MINUTES`; baris job dihapus setelah 30 hari.
- Opsi dari klien difilter berdasarkan definisi alat (whitelist), termasuk struktur data editor.
- Konversi dari URL memblokir alamat privat, loopback, link-local, dan metadata cloud; setiap redirect diperiksa ulang.

## Keterbatasan yang perlu diketahui

- **PDF → Word/Excel** hanya bekerja pada PDF yang berisi teks. PDF hasil scan perlu OCR terlebih dahulu.
- **PDF → PowerPoint** mode "tampilan persis" menghasilkan satu gambar per slide (teks halaman disimpan di catatan slide); mode "bisa diedit" memakai LibreOffice sehingga tata letak bisa bergeser.
- **Edit teks** mengganti potongan teks per baris/segmen; paragraf panjang tidak otomatis mengalir ulang.
- **HTML → PDF** dari URL tidak bisa membuka halaman yang memerlukan login.

## Struktur folder

```
olahpdf/
├── docker-compose.yml, .env.example
├── db/init.sql
├── api/                      Node.js
│   ├── src/  server.js, config.js, db.js, tools.js, validate.js, routes/jobs.js
│   └── public/  index.html, css/app.css, js/{app,ui,editor}.js
└── worker/                   Python
    ├── worker.py             loop antrean, timeout, pembersihan
    ├── olahpdf/  common, convert, organize, security, unwatermark, edit
    └── tests/smoke_test.py
```
