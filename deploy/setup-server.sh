#!/bin/bash
# ==============================================================================
# Script Otomasi Setup & Deploy PDF Editor UIKA (OlahPDF)
# Server: pdf.uika-bogor.ac.id (103.158.196.137)
# ==============================================================================

set -e

DOMAIN="pdf.uika-bogor.ac.id"
APP_DIR="/opt/olahpdf"
SSH_PORT="1961"

echo "======================================================"
echo "  Memulai Setup PDF Editor UIKA di Server: $DOMAIN"
echo "======================================================"

# 1. Update package repository & dependensi dasar
echo "[1/7] Memperbarui paket sistem..."
apt-get update -y
apt-get install -y curl wget git ufw nginx certbot python3-certbot-nginx apt-transport-https ca-certificates gnupg lsb-release

# 2. Pastikan Docker & Docker Compose terpasang
if ! command -v docker &> /dev/null; then
    echo "[2/7] Menginstal Docker..."
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "[2/7] Docker sudah terinstal."
fi

# 3. Konfigurasi Firewall UFW (PENTING: Jangan blokir port SSH 1961!)
echo "[3/7] Mengonfigurasi firewall UFW..."
ufw allow ${SSH_PORT}/tcp comment 'SSH Port Custom'
ufw allow 80/tcp comment 'HTTP Let Encrypt'
ufw allow 443/tcp comment 'HTTPS SSL'
# Aktifkan UFW jika belum
echo "y" | ufw enable || true
ufw status verbose

# 4. Siapkan direktori aplikasi
echo "[4/7] Menyiapkan direktori aplikasi di $APP_DIR..."
mkdir -p "$APP_DIR"
cd "$APP_DIR"

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "File .env berhasil dibuat dari .env.example."
        echo "PERINGATAN: Pastikan Anda mengisi SSO_CLIENT_ID dan SSO_CLIENT_SECRET di $APP_DIR/.env!"
    fi
fi

# 5. Konfigurasi Nginx
echo "[5/7] Mengonfigurasi Nginx untuk $DOMAIN..."
cp "$APP_DIR/deploy/nginx/pdf.uika-bogor.ac.id.conf" /etc/nginx/sites-available/
ln -sf /etc/nginx/sites-available/pdf.uika-bogor.ac.id.conf /etc/nginx/sites-enabled/
# Hapus default site jika ada konflik
rm -f /etc/nginx/sites-enabled/default

nginx -t
systemctl reload nginx

# 6. Pasang SSL Let's Encrypt
echo "[6/7] Memasang sertifikat SSL Let's Encrypt untuk $DOMAIN..."
certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m admin@uika-bogor.ac.id --redirect || {
    echo "Peringatan: Certbot otomatis gagal atau DNS belum terhubung ke IP ini."
    echo "Silakan jalankan secara manual nanti: certbot --nginx -d $DOMAIN"
}

# 7. Jalankan Container dengan Docker Compose
echo "[7/7] Membangun dan menjalankan kontainer OlahPDF..."
docker compose pull || true
docker compose up -d --build

echo ""
echo "======================================================"
echo "  Setup Selesai!"
echo "  Aplikasi berjalan di: https://$DOMAIN"
echo "  Cek status kontainer: docker compose ps"
echo "  Cek log aplikasi    : docker compose logs -f"
echo "======================================================"
