#!/usr/bin/env bash
# ==============================================================================
# Termigo Universal Installer & Manager
# Repository: https://github.com/99apps-id/termigo
#
# Mendukung instalasi:
#   1. Desktop App (AppImage / DEB) + Companion CLI
#   2. Headless VPS Server (24/7 AI Telegram relay + systemd service + Xvfb)
#   3. Standalone Go Companion CLI (termi-go / termigo-go)
#   4. Build & Install dari Source (Tauri 2 + Go)
# ==============================================================================

set -euo pipefail

# --- Warna & Format Output ---
BOLD="\033[1m"
GREEN="\033[0;32m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
MAGENTA="\033[0;35m"
RESET="\033[0m"

info()    { printf "${CYAN}${BOLD}[INFO]${RESET} %s\n" "$*"; }
success() { printf "${GREEN}${BOLD}[OK]${RESET} %s\n" "$*"; }
warn()    { printf "${YELLOW}${BOLD}[PERINGATAN]${RESET} %s\n" "$*"; }
error()   { printf "${RED}${BOLD}[ERROR]${RESET} %s\n" "$*" >&2; }
banner() {
  printf "${BLUE}${BOLD}"
  cat << 'EOF'
  _____                   _             
 |_   _|__ _ __ _ __ ___ (_) __ _  ___  
   | |/ _ \ '__| '_ ` _ \| |/ _` |/ _ \ 
   | |  __/ |  | | | | | | | (_| | (_) |
   |_|\___|_|  |_| |_| |_|_|\__, |\___/ 
                            |___/       
EOF
  printf "${RESET}"
  printf "${BOLD}Termigo - Terminal-first, AI-native Development Environment${RESET}\n"
  printf "${CYAN}Repo: https://github.com/99apps-id/termigo${RESET}\n"
  echo "------------------------------------------------------------------"
}

# --- Direktori & Default ---
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GITHUB_REPO="99apps-id/termigo"
INSTALL_PREFIX="${HOME}/.local"
BIN_DIR="${INSTALL_PREFIX}/bin"
SHARE_DIR="${INSTALL_PREFIX}/share/termigo"
APPS_DIR="${HOME}/.local/share/applications"
ICONS_DIR="${HOME}/.local/share/icons/hicolor/512x512/apps"
OPT_DIR="/opt/termigo"
TARGET_VERSION="latest"
DEFAULT_FORMAT="appimage"
ACTION=""
NON_INTERACTIVE=0

# --- Helper: Download URL ke File (Mendukung curl, wget, python3) ---
http_get() {
  local url="$1"
  local dest="$2"

  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$dest" "$url"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import urllib.request, sys
req = urllib.request.Request('$url', headers={'User-Agent': 'TermigoInstaller'})
with urllib.request.urlopen(req) as resp, open('$dest', 'wb') as f:
    f.write(resp.read())
"
  else
    error "Tidak ada alat download yang tersedia (curl, wget, atau python3)!"
    return 1
  fi
}

http_get_json() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" 2>/dev/null || echo "{}"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO- "$url" 2>/dev/null || echo "{}"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c "
import urllib.request, sys
req = urllib.request.Request('$url', headers={'User-Agent': 'TermigoInstaller'})
try:
    with urllib.request.urlopen(req) as resp:
        print(resp.read().decode())
except Exception:
    print('{}')
"
  else
    echo "{}"
  fi
}

# --- Deteksi Sistem & Arsitektur ---
detect_system() {
  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"

  if [ "$OS" != "linux" ]; then
    error "Skrip installer ini saat ini dioptimalkan untuk Linux. Sistem terdeteksi: $OS"
    exit 1
  fi

  case "$ARCH" in
    x86_64|amd64)
      ARCH_TAG="amd64"
      CLI_ARCH="linux-x64"
      ;;
    aarch64|arm64)
      ARCH_TAG="aarch64"
      CLI_ARCH="linux-arm64"
      ;;
    *)
      error "Arsitektur $ARCH tidak didukung untuk prebuilt release Termigo."
      exit 1
      ;;
  esac

  info "Sistem terdeteksi: Linux ($ARCH_TAG / $CLI_ARCH)"
}

# --- Pastikan PATH mencakup ~/.local/bin ---
ensure_local_bin_in_path() {
  mkdir -p "$BIN_DIR"
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *)
      info "Menambahkan $BIN_DIR ke PATH di shell profile..."
      if [ -f "$HOME/.bashrc" ] && ! grep -q "$BIN_DIR" "$HOME/.bashrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
      fi
      if [ -f "$HOME/.zshrc" ] && ! grep -q "$BIN_DIR" "$HOME/.zshrc" 2>/dev/null; then
        echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
      fi
      export PATH="$BIN_DIR:$PATH"
      ;;
  esac
}

# --- Fetch Metadata Rilis GitHub ---
get_release_info() {
  local ver="$1"
  local url
  if [ "$ver" = "latest" ]; then
    url="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
  else
    url="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${ver}"
  fi

  info "Mengambil informasi rilis dari GitHub ($ver)..."
  local json
  json="$(http_get_json "$url")"

  TAG_NAME="$(python3 -c "import json; data=json.loads('''$json'''); print(data.get('tag_name', ''))" 2>/dev/null || echo "")"
  if [ -z "$TAG_NAME" ]; then
    warn "Gagal mengambil metadata rilis dari GitHub API (mungkin rate limit API). Menggunakan fallback versi v0.9.23."
    TAG_NAME="v0.9.23"
  fi

  VERSION_NUM="${TAG_NAME#v}"
  info "Versi rilis yang dipilih: ${BOLD}${TAG_NAME}${RESET} (v${VERSION_NUM})"
}

# --- Instalasi Companion CLI (termi-go / termigo-go) ---
install_cli() {
  info "Mengunduh companion CLI (termigo-go)..."
  local cli_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/termigo-go-${CLI_ARCH}"
  local tmp_cli="/tmp/termigo-go-${CLI_ARCH}"

  ensure_local_bin_in_path

  if http_get "$cli_url" "$tmp_cli"; then
    chmod +x "$tmp_cli"
    mv -f "$tmp_cli" "${BIN_DIR}/termigo-go"
    ln -sf "${BIN_DIR}/termigo-go" "${BIN_DIR}/termi-go"
    success "Companion CLI terpasang di ${BIN_DIR}/termigo-go (alias: termi-go)"
  else
    warn "Tidak dapat mengunduh prebuilt CLI dari release. Memeriksa ketersediaan build lokal..."
    if [ -f "${SCRIPT_DIR}/cli/cmd/termigo/main.go" ] && command -v go >/dev/null 2>&1; then
      info "Membangun companion CLI dari source lokal..."
      (cd "${SCRIPT_DIR}/cli" && go build -o "${BIN_DIR}/termigo-go" ./cmd/termigo)
      ln -sf "${BIN_DIR}/termigo-go" "${BIN_DIR}/termi-go"
      success "Companion CLI berhasil dikompilasi & dipasang ke ${BIN_DIR}/termigo-go"
    else
      warn "Companion CLI dilewati (Go tidak terpasang dan unduhan gagal)."
    fi
  fi
}

# --- Mode 1: Install Termigo Desktop (AppImage) ---
install_desktop() {
  info "Memulai instalasi Termigo Desktop..."
  get_release_info "$TARGET_VERSION"

  mkdir -p "$SHARE_DIR" "$APPS_DIR" "$ICONS_DIR" "$BIN_DIR"
  ensure_local_bin_in_path

  local asset_name="Termigo_${VERSION_NUM}_${ARCH_TAG}.AppImage"
  local download_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/${asset_name}"
  local target_appimage="${SHARE_DIR}/termigo.AppImage"

  info "Mengunduh AppImage: ${asset_name}..."
  if ! http_get "$download_url" "$target_appimage"; then
    error "Gagal mengunduh AppImage dari $download_url"
    info "Mencoba rilis fallback v0.9.22 jika versi terbaru belum memiliki asset Linux..."
    download_url="https://github.com/${GITHUB_REPO}/releases/download/v0.9.22/Termigo_0.9.22_${ARCH_TAG}.AppImage"
    http_get "$download_url" "$target_appimage" || {
      error "Gagal mengunduh AppImage fallback."
      exit 1
    }
  fi

  chmod +x "$target_appimage"
  success "AppImage tersimpan di ${target_appimage}"

  # Ekstrak AppImage agar tidak bergantung pada FUSE (mengatasi masalah FUSE / fusermount3 di Ubuntu 24.04+)
  info "Mengekstrak AppImage untuk eksekusi native langsung tanpa ketergantungan FUSE..."
  local extract_dir="${SHARE_DIR}/app"
  (
    cd "${SHARE_DIR}"
    "${target_appimage}" --appimage-extract >/dev/null 2>&1 || true
    if [ -d "${SHARE_DIR}/squashfs-root" ]; then
      rm -rf "${extract_dir}"
      mv -f "${SHARE_DIR}/squashfs-root" "${extract_dir}"
    fi
  )

  local exec_target="${extract_dir}/AppRun"
  if [ ! -x "$exec_target" ]; then
    exec_target="$target_appimage"
  fi

  # Wrapper script di ~/.local/bin/termigo dengan patch anti-freeze Linux WebKitGTK dan direct runner
  cat << EOF > "${BIN_DIR}/termigo"
#!/bin/sh
# Fix WebKitGTK DMA-BUF renderer deadlock / freeze on Linux (Wayland, Intel, AMD, NVIDIA)
export WEBKIT_DISABLE_DMABUF_RENDERER="\${WEBKIT_DISABLE_DMABUF_RENDERER:-1}"
export APPIMAGE_EXTRACT_AND_RUN="\${APPIMAGE_EXTRACT_AND_RUN:-1}"

if [ -x "${SHARE_DIR}/app/AppRun" ]; then
  exec "${SHARE_DIR}/app/AppRun" "\$@"
else
  exec "${target_appimage}" "\$@"
fi
EOF
  chmod +x "${BIN_DIR}/termigo"
  success "Symlink / wrapper dibuat di ${BIN_DIR}/termigo (dengan patch WebKitGTK & direct runner)"

  # Pasang Icon
  local logo_src="${SCRIPT_DIR}/public/logo.png"
  local target_icon="${ICONS_DIR}/termigo.png"
  if [ -f "$logo_src" ]; then
    cp -f "$logo_src" "$target_icon"
  elif [ -f "${SCRIPT_DIR}/termigo.png" ]; then
    cp -f "${SCRIPT_DIR}/termigo.png" "$target_icon"
  fi

  # Desktop Entry (Menu Aplikasi) dengan patch anti-freeze
  cat << EOF > "${APPS_DIR}/termigo.desktop"
[Desktop Entry]
Name=Termigo
Comment=Terminal-first, AI-native development environment
Exec=env WEBKIT_DISABLE_DMABUF_RENDERER=1 ${exec_target} %U
Icon=${target_icon}
Terminal=false
Type=Application
Categories=Development;IDE;TerminalEmulator;
StartupWMClass=termigo
MimeType=text/plain;
EOF
  chmod +x "${APPS_DIR}/termigo.desktop"
  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "${APPS_DIR}" 2>/dev/null || true
  fi
  success "Desktop shortcut terpasang di ${APPS_DIR}/termigo.desktop"

  # Pasang Companion CLI
  install_cli

  echo ""
  success "${BOLD}Instalasi Desktop Selesai!${RESET}"
  info "Anda dapat membuka Termigo melalui menu aplikasi atau menjalankan: ${BOLD}termigo${RESET}"
  info "Companion Go CLI dapat dipanggil melalui: ${BOLD}termi-go help${RESET} atau ${BOLD}termigo-go help${RESET}"
}

# --- Mode 2: Install Headless VPS Relay (Server 24/7 Telegram Agent) ---
install_headless_vps() {
  info "Memulai instalasi Termigo Headless VPS (24/7 Agent Relay)..."
  get_release_info "$TARGET_VERSION"

  info "Memeriksa hak akses root / sudo untuk dependensi sistem & systemd..."
  SUDO=""
  if [ "$(id -u)" -ne 0 ]; then
    if command -v sudo >/dev/null 2>&1; then
      SUDO="sudo"
    else
      error "Instalasi headless VPS membutuhkan hak akses root atau sudo!"
      exit 1
    fi
  fi

  # Dependensi sistem
  info "Memasang dependensi headless Linux (xvfb, dbus, webkit2gtk)..."
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -qq || true
    $SUDO apt-get install -y -qq xvfb dbus libgtk-3-0 libwebkit2gtk-4.1-0 libglib2.0-0 libayatana-appindicator3-1 librsvg2-common curl wget || {
      warn "Beberapa paket apt gagal diinstal otomatis, pastikan xvfb dan libwebkit2gtk terpasang."
    }
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y xorg-x11-server-Xvfb dbus webkit2gtk4.1 gtk3 || true
  fi

  # Setup direktori /opt/termigo
  info "Menyiapkan direktori aplikasi di ${OPT_DIR}..."
  $SUDO mkdir -p "$OPT_DIR" "${OPT_DIR}/scripts" "${OPT_DIR}/.watchdog"
  CURRENT_USER="$(id -un)"
  $SUDO chown -R "${CURRENT_USER}:${CURRENT_USER}" "$OPT_DIR"

  # Download binary termigo (extract dari DEB atau AppImage)
  local deb_name="Termigo_${VERSION_NUM}_${ARCH_TAG}.deb"
  local deb_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/${deb_name}"
  local tmp_deb="/tmp/${deb_name}"

  info "Mengunduh paket rilis untuk binary VPS..."
  if http_get "$deb_url" "$tmp_deb"; then
    info "Mengekstrak binary dari deb..."
    local extract_dir="/tmp/termigo_extract_$$"
    mkdir -p "$extract_dir"
    dpkg -x "$tmp_deb" "$extract_dir"
    if [ -f "${extract_dir}/usr/bin/termigo" ]; then
      cp -f "${extract_dir}/usr/bin/termigo" "${OPT_DIR}/termigo"
      chmod +x "${OPT_DIR}/termigo"
      success "Binary termigo terpasang di ${OPT_DIR}/termigo"
    fi
    rm -rf "$extract_dir" "$tmp_deb"
  else
    warn "Gagal mengunduh DEB, mengunduh AppImage sebagai fallback..."
    local appimage_url="https://github.com/${GITHUB_REPO}/releases/download/${TAG_NAME}/Termigo_${VERSION_NUM}_${ARCH_TAG}.AppImage"
    http_get "$appimage_url" "${OPT_DIR}/termigo"
    chmod +x "${OPT_DIR}/termigo"
  fi

  # Pastikan run-headless.sh dan watchdog script terpasang di /opt/termigo/scripts
  info "Menyiapkan launcher headless & scripts..."
  if [ -f "${SCRIPT_DIR}/scripts/run-headless.sh" ]; then
    cp -f "${SCRIPT_DIR}/scripts/run-headless.sh" "${OPT_DIR}/scripts/run-headless.sh"
  fi
  if [ -f "${SCRIPT_DIR}/scripts/deploy-termigo.sh" ]; then
    cp -f "${SCRIPT_DIR}/scripts/deploy-termigo.sh" "${OPT_DIR}/scripts/deploy-termigo.sh"
  fi
  if [ -f "${SCRIPT_DIR}/scripts/termigo-watchdog.sh" ]; then
    cp -f "${SCRIPT_DIR}/scripts/termigo-watchdog.sh" "${OPT_DIR}/scripts/termigo-watchdog.sh"
  fi
  chmod +x "${OPT_DIR}/scripts/"*.sh 2>/dev/null || true

  # Salin termigo-cli companion jika tersedia
  install_cli
  if [ -f "${BIN_DIR}/termigo-go" ]; then
    cp -f "${BIN_DIR}/termigo-go" "${OPT_DIR}/termigo-cli"
    chmod +x "${OPT_DIR}/termigo-cli"
  fi

  # Pasang systemd service
  info "Mengonfigurasi systemd unit termigo.service..."
  cat << EOF | $SUDO tee /etc/systemd/system/termigo.service > /dev/null
[Unit]
Description=Termigo Headless AI Telegram Relay
After=network.target

[Service]
Type=simple
User=${CURRENT_USER}
WorkingDirectory=${OPT_DIR}
ExecStart=${OPT_DIR}/scripts/run-headless.sh
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal
LimitNOFILE=65536
MemoryHigh=3072M
MemoryMax=3584M

[Install]
WantedBy=multi-user.target
EOF

  $SUDO systemctl daemon-reload
  success "Service /etc/systemd/system/termigo.service berhasil dipasang"

  if [ "$NON_INTERACTIVE" = "1" ]; then
    info "Non-interactive mode: melewati start service otomatis."
  else
    echo ""
    info "Apakah Anda ingin mengaktifkan dan menjalankan termigo.service sekarang? (y/n)"
    read -r -p "> " start_svc || start_svc="n"
    if [[ "$start_svc" =~ ^[Yy]$ ]]; then
      $SUDO systemctl enable --now termigo
      success "termigo.service telah diaktifkan dan dijalankan!"
      info "Cek status dengan: ${BOLD}sudo systemctl status termigo${RESET}"
      info "Cek log dengan:    ${BOLD}sudo journalctl -u termigo -f${RESET}"
    else
      info "Service tidak langsung dijalankan. Untuk menjalankan nanti:"
      info "  ${BOLD}sudo systemctl enable --now termigo${RESET}"
    fi
  fi

  echo ""
  success "${BOLD}Instalasi Headless VPS Selesai!${RESET}"
  info "Folder data & konfigurasi: ~/.local/share/id.99apps.termigo/"
  info "Panduan Telegram relay: docs/headless-vps.md"
}

# --- Mode 3: Build from Source ---
build_from_source() {
  info "Memeriksa toolchain untuk kompilasi dari source..."

  local missing=()
  command -v node >/dev/null 2>&1 || missing+=("node (Node.js 22+)")
  command -v pnpm >/dev/null 2>&1 || missing+=("pnpm")
  command -v cargo >/dev/null 2>&1 || missing+=("cargo/rustc (Rust stable)")
  command -v gcc >/dev/null 2>&1 || missing+=("gcc / build-essential")

  if [ ${#missing[@]} -gt 0 ]; then
    error "Dependensi build belum lengkap:"
    for m in "${missing[@]}"; do
      echo "  - $m"
    done
    echo ""
    info "Instalasi yang dibutuhkan:"
    echo "  Rust:    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo "  Node.js: nvm install 22 || curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
    echo "  pnpm:    corepack enable || npm i -g pnpm"
    echo "  Sistem:  sudo apt install -y build-essential libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev"
    exit 1
  fi

  info "Menginstal dependensi Node via pnpm..."
  (cd "$SCRIPT_DIR" && pnpm install)

  info "Membangun companion CLI Go..."
  if [ -f "${SCRIPT_DIR}/scripts/build-cli.mjs" ]; then
    (cd "$SCRIPT_DIR" && node scripts/build-cli.mjs)
  fi

  info "Membangun aplikasi Termigo (Tauri 2 + Vite frontend)..."
  (cd "$SCRIPT_DIR" && pnpm tauri build --no-bundle)

  local release_bin="${SCRIPT_DIR}/src-tauri/target/release/termigo"
  if [ -f "$release_bin" ]; then
    ensure_local_bin_in_path
    cp -f "$release_bin" "${BIN_DIR}/termigo"
    chmod +x "${BIN_DIR}/termigo"
    success "Binary berhasil dikompilasi dan dipasang di ${BIN_DIR}/termigo"
  else
    error "Kompilasi selesai tetapi binary tidak ditemukan di src-tauri/target/release/termigo"
    exit 1
  fi
}

# --- Mode 4: Cek Status Instalasi ---
check_status() {
  echo ""
  printf "${BOLD}=== Status Instalasi Termigo ===${RESET}\n"

  printf "1. Desktop Binary (${BIN_DIR}/termigo): "
  if [ -x "${BIN_DIR}/termigo" ]; then
    printf "${GREEN}Terpasang${RESET}\n"
  else
    printf "${YELLOW}Tidak ditemukan${RESET}\n"
  fi

  printf "2. Go Companion CLI (${BIN_DIR}/termigo-go): "
  if [ -x "${BIN_DIR}/termigo-go" ]; then
    printf "${GREEN}Terpasang${RESET} ("
    "${BIN_DIR}/termigo-go" version 2>/dev/null || echo "aktif"
    printf ")\n"
  else
    printf "${YELLOW}Tidak ditemukan${RESET}\n"
  fi

  printf "3. VPS Directory (${OPT_DIR}/termigo): "
  if [ -x "${OPT_DIR}/termigo" ]; then
    printf "${GREEN}Terpasang${RESET}\n"
  else
    printf "${YELLOW}Tidak ditemukan${RESET}\n"
  fi

  printf "4. systemd Service (termigo.service): "
  if systemctl list-unit-files termigo.service >/dev/null 2>&1; then
    local state
    state="$(systemctl is-active termigo 2>/dev/null || echo "inactive")"
    if [ "$state" = "active" ]; then
      printf "${GREEN}Active / Running${RESET}\n"
    else
      printf "${YELLOW}%s${RESET}\n" "$state"
    fi
  else
    printf "${YELLOW}Tidak terdaftar${RESET}\n"
  fi

  printf "5. App Data Store (~/.local/share/id.99apps.termigo): "
  if [ -d "${HOME}/.local/share/id.99apps.termigo" ]; then
    printf "${GREEN}Ada${RESET} ($(du -sh "${HOME}/.local/share/id.99apps.termigo" 2>/dev/null | cut -f1))\n"
  else
    printf "${YELLOW}Belum ada${RESET}\n"
  fi
  echo ""
}

# --- Mode 5: Uninstall ---
uninstall_termigo() {
  warn "Apakah Anda yakin ingin menghapus instalasi Termigo? (y/n)"
  read -r -p "> " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    info "Penghapusan dibatalkan."
    return 0
  fi

  info "Menghapus binary desktop & CLI..."
  rm -f "${BIN_DIR}/termigo" "${BIN_DIR}/termigo-go" "${BIN_DIR}/termi-go"
  rm -rf "$SHARE_DIR" "${APPS_DIR}/termigo.desktop" "${ICONS_DIR}/termigo.png"

  if [ -f "/etc/systemd/system/termigo.service" ]; then
    info "Menghentikan dan menghapus systemd service..."
    if command -v sudo >/dev/null 2>&1; then
      sudo systemctl stop termigo 2>/dev/null || true
      sudo systemctl disable termigo 2>/dev/null || true
      sudo rm -f "/etc/systemd/system/termigo.service"
      sudo systemctl daemon-reload
    fi
  fi

  if [ -d "$OPT_DIR" ]; then
    info "Menghapus direktori VPS /opt/termigo..."
    if command -v sudo >/dev/null 2>&1; then
      sudo rm -rf "$OPT_DIR"
    fi
  fi

  success "Termigo berhasil dihapus dari sistem."
  info "Catatan: Data konfigurasi di ~/.local/share/id.99apps.termigo sengaja disimpan untuk keamanan backup."
}

# --- Menu Interaktif ---
interactive_menu() {
  banner
  detect_system

  echo "Pilih opsi instalasi atau pengelolaan Termigo:"
  echo "  1) Install Desktop App (AppImage) + Companion CLI (Rekomendasi untuk PC/Laptop)"
  echo "  2) Install Headless VPS (24/7 Telegram AI Relay + systemd service)"
  echo "  3) Install Companion CLI saja (termi-go / termigo-go)"
  echo "  4) Build & Install dari Source (Tauri 2 + Go compiler)"
  echo "  5) Cek Status Instalasi"
  echo "  6) Uninstall Termigo"
  echo "  0) Keluar"
  echo ""
  read -r -p "Masukkan pilihan [1-6]: " choice

  case "$choice" in
    1) install_desktop ;;
    2) install_headless_vps ;;
    3) get_release_info "$TARGET_VERSION"; install_cli ;;
    4) build_from_source ;;
    5) check_status ;;
    6) uninstall_termigo ;;
    0) exit 0 ;;
    *) error "Pilihan tidak valid!"; exit 1 ;;
  esac
}

# --- Parsing Argumen CLI ---
show_help() {
  banner
  cat << EOF
Penggunaan: ./install.sh [OPSI]

Opsi Utama:
  --desktop             Instalasi Termigo Desktop AppImage + CLI
  --headless, --vps     Instalasi mode Headless VPS (Telegram relay + systemd)
  --cli                 Hanya pasang Go Companion CLI (termi-go)
  --source              Build & install dari source code lokal
  --status              Periksa status komponen Termigo di sistem
  --uninstall           Hapus instalasi Termigo dari sistem

Opsi Tambahan:
  --version <v>         Tentukan versi rilis (default: latest, contoh: v0.9.23)
  --prefix <path>       Prefix lokasi instalasi (default: ~/.local)
  -y, --non-interactive Jalankan tanpa pertanyaan interaktif
  -h, --help            Tampilkan bantuan ini

Contoh:
  ./install.sh --desktop
  ./install.sh --headless
  ./install.sh --cli
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --desktop) ACTION="desktop"; shift ;;
    --headless|--vps) ACTION="headless"; shift ;;
    --cli) ACTION="cli"; shift ;;
    --source) ACTION="source"; shift ;;
    --status) ACTION="status"; shift ;;
    --uninstall) ACTION="uninstall"; shift ;;
    --version) TARGET_VERSION="$2"; shift 2 ;;
    --prefix) INSTALL_PREFIX="$2"; BIN_DIR="${INSTALL_PREFIX}/bin"; shift 2 ;;
    -y|--non-interactive) NON_INTERACTIVE=1; shift ;;
    -h|--help) show_help; exit 0 ;;
    *) error "Argumen tidak dikenal: $1"; show_help; exit 1 ;;
  esac
done

# --- Eksekusi Utama ---
if [ -z "$ACTION" ]; then
  if [ "$NON_INTERACTIVE" = "1" ]; then
    ACTION="desktop"
    detect_system
    install_desktop
  else
    interactive_menu
  fi
else
  banner
  detect_system
  case "$ACTION" in
    desktop) install_desktop ;;
    headless) install_headless_vps ;;
    cli) get_release_info "$TARGET_VERSION"; install_cli ;;
    source) build_from_source ;;
    status) check_status ;;
    uninstall) uninstall_termigo ;;
  esac
fi
