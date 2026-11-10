FROM python:3.12-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright

# LibreOffice (konversi Office ↔ PDF), Ghostscript (PDF/A), font yang kompatibel dengan dokumen Office
RUN apt-get update && apt-get install -y --no-install-recommends \
        libreoffice-writer libreoffice-calc libreoffice-impress libreoffice-draw \
        ghostscript \
        libatomic1 \
        fonts-dejavu-core fonts-liberation2 fonts-crosextra-carlito fonts-crosextra-caladea \
        fonts-noto-core fonts-noto-ui-core \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt \
    && playwright install --with-deps chromium \
    && chmod -R a+rx /opt/ms-playwright

COPY . .
RUN useradd --create-home --uid 1000 app && mkdir -p /data && chown app:app /data
USER app

ENV STORAGE_DIR=/data \
    WATERMARK_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf

CMD ["python", "worker.py"]
