#!/usr/bin/env bash
set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

check() { printf "  %-50s" "$1"; }
pass() { printf "${GREEN}✓${NC}\n"; }
fail() { printf "${RED}✗${NC}  %s\n" "$1"; }
warn() { printf "${YELLOW}⚠${NC}  %s\n" "$1"; }
header() { printf "\n${BOLD}%s${NC}\n" "$1"; }

ERRORS=0
WARNINGS=0

echo ""
echo "  🐟  Mozy Stock Dashboard — Setup Check"
echo "  ─────────────────────────────────────"

# ── Node.js ──
header "1. Node.js"
check "node --version"
if command -v node &>/dev/null; then
  v=$(node --version | sed 's/v//')
  maj=$(echo "$v" | cut -d. -f1)
  if [ "$maj" -ge 18 ]; then
    pass; echo "         node $v ($(which node))"
  else
    fail "node $v — cần >= 18"; ERRORS=$((ERRORS+1))
  fi
else
  fail "chưa cài Node.js"; ERRORS=$((ERRORS+1))
fi

check "npm --version"
if command -v npm &>/dev/null; then
  pass; echo "         npm $(npm --version)"
else
  fail "chưa có npm"; ERRORS=$((ERRORS+1))
fi

# ── Config ──
header "2. Config"
check "config.json"
if [ -f config.json ]; then
  pass
  tickers=$(node -e "console.log(require('./config.json').tickers.join(', '))" 2>/dev/null || echo "?")
  echo "         Watchlist: $tickers"
else
  warn "chưa có config.json — tạo từ config.example.json"
  if [ -f config.example.json ]; then
    cp config.example.json config.json
    echo "         Đã copy config.example.json → config.json"
    echo "         ${YELLOW}⚠ Sửa tickers trong config.json theo watchlist của bạn${NC}"
  fi
  WARNINGS=$((WARNINGS+1))
fi

# ── Dependencies ──
header "3. npm dependencies"
check "node_modules"
if [ -d node_modules ]; then
  pass
else
  warn "chưa có node_modules — chạy npm install"
  npm install
  pass; echo "         Đã cài xong"
fi

# ── Mozyfin CLI ──
header "4. Mozyfin CLI"
check "mozyfin command"
if command -v mozyfin &>/dev/null; then
  pass; echo "         $(which mozyfin)"
else
  fail "chưa cài mozyfin CLI"
  echo ""
  echo "  ${YELLOW}Cài ngay:${NC}"
  echo "    npm install -g mozyfin-cli"
  echo ""
  ERRORS=$((ERRORS+1))
fi

# ── Mozyfin auth ──
header "5. Mozyfin Authentication"
AUTH_OK=0
if [ -f ~/.config/mozyfin-cli/config.json ] 2>/dev/null; then
  AUTH_OK=1
elif [ -n "${MOZYFIN_API_KEY:-}" ]; then
  AUTH_OK=1
fi

check "API key / login"
if [ "$AUTH_OK" -eq 1 ]; then
  pass
  if [ -n "${MOZYFIN_API_KEY:-}" ]; then
    echo "         Key source: MOZYFIN_API_KEY env"
  else
    echo "         Key source: ~/.config/mozyfin-cli/config.json"
  fi
else
  fail "chưa có API key"
  echo ""
  echo "  ${YELLOW}Làm 1 trong 2 cách:${NC}"
  echo "    1. Login:  mozyfin login --api-key <KEY>"
  echo "    2. Env:    cp .env.example .env → sửa key → source .env"
  echo ""
  echo "  Lấy API key tại: https://mozy.vn"
  echo ""
  ERRORS=$((ERRORS+1))
fi

# ── Connectivity ──
header "6. Mozyfin API connectivity"
check "mozyfin quote VCB.VN"
if command -v mozyfin &>/dev/null; then
  if mozyfin quote VCB.VN --limit 1 &>/dev/null; then
    pass; echo "         API OK"
  else
    warn "không gọi được API — kiểm tra network hoặc API key"
    WARNINGS=$((WARNINGS+1))
  fi
else
  warn "bỏ qua (chưa cài mozyfin)"; WARNINGS=$((WARNINGS+1))
fi

# ── Dashboard ──
header "7. Dashboard server"
check "port $(node -e "try{console.log(require('./config.json').port)}catch{console.log(7878)}")"
NODE_PID=$(lsof -ti tcp:7878 2>/dev/null || true)
if [ -n "$NODE_PID" ]; then
  warn "port 7878 đang có process (PID $NODE_PID) — dashboard có thể đã chạy"
else
  pass; echo "         Sẵn sàng — npm start để khởi động"
fi

# ── Summary ──
echo ""
echo "  ─────────────────────────────────────"
if [ "$ERRORS" -eq 0 ] && [ "$WARNINGS" -eq 0 ]; then
  echo "  ${GREEN}${BOLD}✅ Sẵn sàng!${NC}"
  echo ""
  echo "  Chạy dashboard:"
  echo "    npm run pipeline:eod   # lấy data lần đầu"
  echo "    npm start              # mở http://127.0.0.1:7878"
elif [ "$ERRORS" -eq 0 ]; then
  echo "  ${YELLOW}${BOLD}⚠️  Có $WARNINGS cảnh báo — vẫn chạy được${NC}"
else
  echo "  ${RED}${BOLD}❌ $ERRORS lỗi + $WARNINGS cảnh báo — cần fix trước khi chạy${NC}"
fi
echo ""
