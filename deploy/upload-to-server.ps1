# Script untuk mengunggah repository OlahPDF ke server UIKA
# Penggunaan: .\deploy\upload-to-server.ps1

$ServerHost = "103.158.196.137"
$ServerPort = "1961"
$ServerUser = "root"
$RemoteDir = "/opt/olahpdf"

Write-Host "Mengirim file OlahPDF ke server $ServerHost:$RemoteDir via SSH port $ServerPort..." -ForegroundColor Cyan

# Pastikan folder remote ada
ssh -p $ServerPort "$ServerUser@$ServerHost" "mkdir -p $RemoteDir"

# Upload file project menggunakan SCP (kecuali node_modules, .venv, .git, uploads, outputs)
scp -P $ServerPort -r `
  ./api `
  ./worker `
  ./db `
  ./deploy `
  ./docker-compose.yml `
  ./.env.example `
  ./README.md `
  "$ServerUser@$($ServerHost):$RemoteDir/"

Write-Host "Upload selesai! Silakan login ke server:" -ForegroundColor Green
Write-Host "ssh -p $ServerPort $ServerUser@$ServerHost" -ForegroundColor Yellow
Write-Host "cd $RemoteDir && bash deploy/setup-server.sh" -ForegroundColor Yellow

