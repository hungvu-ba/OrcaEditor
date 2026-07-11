#!/usr/bin/env bash
#
# Build → kiểm thử → đóng gói .vsix → (tuỳ chọn) cài vào VS Code / Cursor / VSCodium.
# Gộp 3 script cũ (build.sh, install.sh, build-and-install.sh) làm một, dùng subcommand.
#
# Cách dùng:
#   ./build.sh                  # đầy đủ: typecheck + test + package + install (mặc định)
#   ./build.sh build            # chỉ build + package, không cài
#   ./build.sh install [file]   # chỉ cài .vsix mới nhất (hoặc file chỉ định), không build
#   ./build.sh release          # build bản production + publish lên VS Code Marketplace
#   ./build.sh --skip-tests     # bỏ qua typecheck & round-trip test
#   ./build.sh --no-install     # chỉ tạo .vsix, không cài
#   ./build.sh --bump           # tăng version patch (0.5.2 -> 0.5.3) trước khi build
#
# Tuỳ chọn riêng cho release:
#   ./build.sh release --patch|--minor|--major   # bump version trước khi publish
#   ./build.sh release --dry-run                 # chạy đủ các bước nhưng KHÔNG publish/tag
#
# Yêu cầu trước khi release: đã có publisher trên https://marketplace.visualstudio.com/manage
# và đã đăng nhập (npx vsce login <publisher>) hoặc export VSCE_PAT=<Personal Access Token>.
#
set -euo pipefail

# Luôn chạy từ thư mục chứa script (gốc dự án), dù gọi từ đâu.
cd "$(dirname "$0")"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
ok()   { printf '\033[1;32m✓ %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; }

do_build() {
  local skip_tests=$1 do_bump=$2

  command -v node >/dev/null || die "Chưa cài Node.js"
  [ -d node_modules ] || { step "Cài dependencies (npm install)"; npm install; }

  if [ "$do_bump" = 1 ]; then
    step "Tăng version (patch)"
    npm version patch --no-git-tag-version >/dev/null
    ok "Version mới: $(node -p "require('./package.json').version")"
  fi

  local version name vsix
  version="$(node -p "require('./package.json').version")"
  name="$(node -p "require('./package.json').name")"
  vsix="${name}-${version}.vsix"

  if [ "$skip_tests" = 0 ]; then
    step "Typecheck (tsc --noEmit)"
    npm run typecheck
    ok "Typecheck sạch"

    step "Round-trip test"
    npm run test:roundtrip | tail -1
    ok "Test pass"
  fi

  step "Đóng gói .vsix (v${version})"
  npm run package
  [ -f "$vsix" ] || die "Không thấy $vsix sau khi đóng gói"
  ok "Đã tạo $vsix"

  echo "File: $(pwd)/$vsix"
}

do_release() {
  local skip_tests=$1 bump=$2 dry_run=$3

  command -v node >/dev/null || die "Chưa cài Node.js"
  [ -d node_modules ] || { step "Cài dependencies (npm install)"; npm install; }

  local name publisher
  name="$(node -p "require('./package.json').name")"
  publisher="$(node -p "require('./package.json').publisher")"

  # Cây git phải sạch để tag/publish đúng nội dung đang có trong repo.
  if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
    if [ "$dry_run" = 1 ]; then
      printf '\033[1;33m⚠ Cây git chưa sạch (bỏ qua vì --dry-run)\033[0m\n'
    else
      die "Cây git chưa sạch. Commit hoặc stash thay đổi trước khi release."
    fi
  fi

  # Kiểm tra đăng nhập Marketplace trước khi làm gì tốn thời gian.
  if [ "$dry_run" = 0 ]; then
    step "Kiểm tra đăng nhập Marketplace (publisher: ${publisher})"
    if [ -n "${VSCE_PAT:-}" ]; then
      npx vsce verify-pat "$publisher" >/dev/null 2>&1 || die "VSCE_PAT không hợp lệ cho publisher '${publisher}'"
      ok "VSCE_PAT hợp lệ"
    elif npx vsce ls-publishers 2>/dev/null | grep -qx "$publisher"; then
      ok "Đã đăng nhập với publisher '${publisher}'"
    else
      die "Chưa đăng nhập Marketplace. Chạy: npx vsce login ${publisher}  (hoặc export VSCE_PAT=<token>)"
    fi
  fi

  if [ -n "$bump" ]; then
    step "Tăng version (${bump})"
    npm version "$bump" --no-git-tag-version >/dev/null
    ok "Version mới: $(node -p "require('./package.json').version")"
  fi

  local version vsix tag
  version="$(node -p "require('./package.json').version")"
  vsix="${name}-${version}.vsix"
  tag="v${version}"

  if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null 2>&1 && [ "$dry_run" = 0 ]; then
    die "Tag ${tag} đã tồn tại. Dùng --patch/--minor/--major để bump version mới."
  fi

  if [ "$skip_tests" = 0 ]; then
    step "Typecheck (tsc --noEmit)"
    npm run typecheck
    ok "Typecheck sạch"

    step "Lint (eslint)"
    npm run lint
    ok "Lint sạch"

    step "Test (round-trip + unit)"
    npm test | tail -2
    ok "Test pass"
  fi

  step "Đóng gói .vsix bản production (v${version})"
  npm run package
  [ -f "$vsix" ] || die "Không thấy $vsix sau khi đóng gói"
  ok "Đã tạo $vsix ($(du -h "$vsix" | cut -f1 | tr -d ' '))"

  if [ "$dry_run" = 1 ]; then
    printf '\n\033[1;33m⚠ --dry-run: dừng tại đây, KHÔNG publish/tag.\033[0m\n'
    echo "File: $(pwd)/$vsix"
    return 0
  fi

  step "Publish lên VS Code Marketplace"
  npx vsce publish --no-dependencies --packagePath "$vsix"
  ok "Đã publish ${publisher}.${name} v${version}"

  step "Commit version bump & tag ${tag}"
  if [ -n "$(git status --porcelain -- package.json package-lock.json)" ]; then
    git add package.json package-lock.json
    git commit -m "release: v${version}" >/dev/null
    ok "Đã commit version bump"
  fi
  git tag "$tag"
  ok "Đã tạo tag ${tag}"

  printf '\n\033[1;32mHoàn tất!\033[0m Đẩy lên remote bằng: git push && git push --tags\n'
  echo "Trang quản lý: https://marketplace.visualstudio.com/manage/publishers/${publisher}"
  echo "Trang extension: https://marketplace.visualstudio.com/items?itemName=${publisher}.${name}"
}

do_install() {
  local vsix="${1:-}"

  command -v node >/dev/null || die "Chưa cài Node.js"

  local name publisher
  name="$(node -p "require('./package.json').name")"
  publisher="$(node -p "require('./package.json').publisher")"

  if [ -z "$vsix" ]; then
    step "Tìm file .vsix mới nhất"
    vsix="$(ls -t "${name}"-*.vsix 2>/dev/null | head -1 || true)"
  fi
  [ -n "$vsix" ] && [ -f "$vsix" ] || die "Không tìm thấy file .vsix. Chạy ./build.sh build trước, hoặc truyền đường dẫn file."
  ok "Sẽ cài: $vsix"

  # Tìm CLI của editor: ưu tiên PATH, rồi các đường dẫn app quen thuộc trên macOS.
  step "Tìm CLI của VS Code / Cursor"
  local code_cli=""
  for c in code cursor codium; do
    if command -v "$c" >/dev/null 2>&1; then code_cli="$c"; break; fi
  done
  if [ -z "$code_cli" ]; then
    for p in \
      "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor" \
      "/Applications/Cursor.app/Contents/Resources/app/bin/code" \
      "/Applications/VSCodium.app/Contents/Resources/app/bin/codium"; do
      if [ -x "$p" ]; then code_cli="$p"; break; fi
    done
  fi
  [ -n "$code_cli" ] || die "Không tìm thấy CLI của VS Code/Cursor. Cài thủ công: mở VS Code → Extensions → '...' → Install from VSIX → chọn $vsix"
  ok "Dùng: $code_cli"

  step "Cài đặt extension"
  "$code_cli" --install-extension "$vsix" --force 2>&1 | grep -viE "DeprecationWarning|trace-deprecation" || true

  local installed
  installed="$("$code_cli" --list-extensions --show-versions 2>/dev/null | grep -i "${publisher}.${name}" || true)"
  [ -n "$installed" ] || die "Cài xong nhưng không thấy extension trong danh sách"
  ok "Đã cài: $installed"

  printf '\n\033[1;33m⚠ Cần reload để nạp bản mới:\033[0m Cmd+Shift+P → "Developer: Reload Window"\n'
}

MODE=""
SKIP_TESTS=0
DO_BUMP=0
DO_INSTALL=1
INSTALL_FILE=""
RELEASE_BUMP=""
DRY_RUN=0

for arg in "$@"; do
  case "$arg" in
    build|install|release) [ -z "$MODE" ] && MODE="$arg" || INSTALL_FILE="$arg" ;;
    --skip-tests)  SKIP_TESTS=1 ;;
    --bump)        DO_BUMP=1 ;;
    --no-install)  DO_INSTALL=0 ;;
    --patch|--minor|--major) RELEASE_BUMP="${arg#--}" ;;
    --dry-run)     DRY_RUN=1 ;;
    -h|--help)     usage; exit 0 ;;
    *)
      if [ "$MODE" = "install" ] && [ -z "$INSTALL_FILE" ]; then
        INSTALL_FILE="$arg"
      else
        echo "Tham số không hiểu: $arg (dùng --help)"; exit 2
      fi
      ;;
  esac
done

case "$MODE" in
  install)
    do_install "$INSTALL_FILE"
    ;;
  build)
    do_build "$SKIP_TESTS" "$DO_BUMP"
    ;;
  release)
    do_release "$SKIP_TESTS" "$RELEASE_BUMP" "$DRY_RUN"
    ;;
  "")
    do_build "$SKIP_TESTS" "$DO_BUMP"
    if [ "$DO_INSTALL" = 1 ]; then
      do_install ""
    fi
    ;;
esac
