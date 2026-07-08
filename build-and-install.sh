#!/usr/bin/env bash
#
# Build → kiểm thử → đóng gói .vsix → cài vào VS Code.
#
# Cách dùng:
#   ./build-and-install.sh              # đầy đủ: typecheck + test + package + install
#   ./build-and-install.sh --skip-tests # bỏ qua typecheck & round-trip test
#   ./build-and-install.sh --no-install # chỉ tạo .vsix, không cài
#   ./build-and-install.sh --bump       # tăng version patch (0.5.2 -> 0.5.3) trước khi build
#
set -euo pipefail

# Luôn chạy từ thư mục chứa script (gốc dự án), dù gọi từ đâu.
cd "$(dirname "$0")"

SKIP_TESTS=0
DO_INSTALL=1
DO_BUMP=0
for arg in "$@"; do
  case "$arg" in
    --skip-tests) SKIP_TESTS=1 ;;
    --no-install) DO_INSTALL=0 ;;
    --bump)       DO_BUMP=1 ;;
    -h|--help)
      grep '^#' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Tham số không hiểu: $arg (dùng --help)"; exit 2 ;;
  esac
done

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

command -v node >/dev/null || die "Chưa cài Node.js"
[ -d node_modules ] || { step "Cài dependencies (npm install)"; npm install; }

if [ "$DO_BUMP" = 1 ]; then
  step "Tăng version (patch)"
  npm version patch --no-git-tag-version >/dev/null
  ok "Version mới: $(node -p "require('./package.json').version")"
fi

VERSION="$(node -p "require('./package.json').version")"
NAME="$(node -p "require('./package.json').name")"
PUBLISHER="$(node -p "require('./package.json').publisher")"
VSIX="${NAME}-${VERSION}.vsix"

if [ "$SKIP_TESTS" = 0 ]; then
  step "Typecheck (tsc --noEmit)"
  npm run typecheck
  ok "Typecheck sạch"

  step "Round-trip test"
  npm run test:roundtrip | tail -1
  ok "Test pass"
fi

step "Đóng gói .vsix (v${VERSION})"
npm run package
[ -f "$VSIX" ] || die "Không thấy $VSIX sau khi đóng gói"
ok "Đã tạo $VSIX"

if [ "$DO_INSTALL" = 0 ]; then
  step "Bỏ qua cài đặt (--no-install)"
  echo "File: $(pwd)/$VSIX"
  exit 0
fi

# Tìm CLI của editor: ưu tiên PATH, rồi các đường dẫn app quen thuộc trên macOS.
step "Tìm CLI của VS Code / Cursor"
CODE_CLI=""
for c in code cursor codium; do
  if command -v "$c" >/dev/null 2>&1; then CODE_CLI="$c"; break; fi
done
if [ -z "$CODE_CLI" ]; then
  for p in \
    "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
    "/Applications/Cursor.app/Contents/Resources/app/bin/code" \
    "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"; do
    if [ -x "$p" ]; then CODE_CLI="$p"; break; fi
  done
fi
[ -n "$CODE_CLI" ] || die "Không tìm thấy CLI của VS Code/Cursor. Cài thủ công: mở VS Code → Extensions → '...' → Install from VSIX → chọn $VSIX"
ok "Dùng: $CODE_CLI"

step "Cài đặt extension"
"$CODE_CLI" --install-extension "$VSIX" --force 2>&1 | grep -viE "DeprecationWarning|trace-deprecation" || true

INSTALLED="$("$CODE_CLI" --list-extensions --show-versions 2>/dev/null | grep -i "${PUBLISHER}.${NAME}" || true)"
[ -n "$INSTALLED" ] || die "Cài xong nhưng không thấy extension trong danh sách"
ok "Đã cài: $INSTALLED"

printf '\n\033[1;33m⚠ Cần reload để nạp bản mới:\033[0m Cmd+Shift+P → "Developer: Reload Window"\n'
