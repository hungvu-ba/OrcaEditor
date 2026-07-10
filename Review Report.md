# Báo cáo Review Source Base

> **Đối tượng:** extension `markdown-wysiwyg-preview` (Orca MD Preview) — `v0.5.14`
> **Ngày:** 2026-07-10 · **Phương án:** theo [Review Plan.md](Review%20Plan.md)
> **Cách làm:** 3 agent review song song (Security / Performance / Convention), mỗi finding **đã đọc & xác minh trên code thật** (`file:line`), kèm kiểm tra tự động `npm audit` + `tsc --noEmit`.

---

## Tóm tắt điều hành

Codebase **chất lượng tốt, phòng thủ trên mức trung bình**. Không có lỗ hổng thực thi code hay rò rỉ dữ liệu cục bộ. Điểm cần cải thiện chủ yếu là **hiệu năng** (2 mục High) và **cấu trúc/bảo trì**.

| Phương diện | Critical | High | Medium | Low | Đã phòng thủ/không phải lỗi |
|---|:--:|:--:|:--:|:--:|---|
| 🔴 Security | 0 | 0 | 3 | 3 | openLink allowlist, paste text/plain, mermaid strict, validate message, CVE (npm audit sạch) |
| 🟡 Performance | 0 | 2 | 4 | 3 | không leak listener, CSS Highlight API, hljs subset, sync có debounce |
| 🟢 Convention | 0 | 0 | 3 | 6 | không `any`/`TODO`/`console` lọt prod, `tsc` sạch, .vsix đã gitignore |

**Kiểm tra tự động:** `npm audit` → **0 vulnerabilities** (441 deps); `tsc --noEmit` → **sạch**; bundle webview dev **9.37 MB chưa minify**.

### 🎯 5 việc đáng làm nhất (impact/effort)
1. **[P-02] Sửa 1 dòng** `vscode:prepublish` thêm `--production` → giảm ~60% bundle (9.4 MB → 3.9 MB) ngay lập tức.
2. **[S2/S1] Siết CSP:** bỏ `https:` khỏi `img-src`, thêm `form-action 'none'` → chặn phone-home + form exfil.
3. **[P-01] Debounce** update từ bên ngoài + cache Mermaid SVG → hết nghẽn khi gõ ở editor cạnh preview.
4. **[P-03] Đảo thứ tự** kiểm tra "nội dung có đổi" TRƯỚC clone+turndown trong `syncNow`.
5. **[P-05] Debounce** ô tìm kiếm + tách pha đọc/ghi layout.

---

## 1. 🔴 Security

**Bối cảnh phòng thủ:** CSP thực tế (`default-src 'none'` + `script-src 'nonce-'` không `unsafe-inline`) đã chặn toàn bộ đường XSS→thực thi code; `openLink` có allowlist scheme. Vì vậy rủi ro còn lại thuộc nhóm **privacy/residual mức Medium trở xuống**.

### S2 · **Medium** · [provider.ts:450](src/provider.ts#L450), render tại [main.ts:144](media/webview/main.ts#L144)
- **Mô tả:** CSP cho phép `img-src https:`; nội dung `.md` render qua `html:true` rồi `innerHTML` không sanitize.
- **Tác động:** **Phone-home zero-click** — chỉ cần mở preview là ảnh remote tự load, lộ IP/thời điểm (như tracking-pixel). Không rò rỉ nội dung file cục bộ.
- **Tái hiện:** Mở `.md` chứa `<img src="https://evil.tld/beacon.gif?x">` → request tự bắn khi render, không cần click.
- **Fix:** Đổi thành `img-src ${cspSource} data:` (bỏ `https:`); nếu cần ảnh remote thì proxy qua host có xác nhận, hoặc tài liệu hóa rủi ro.

### S1 · **Medium** · [pipeline.ts:69](media/webview/pipeline.ts#L69) (`html:true`), [main.ts:144](media/webview/main.ts#L144)
- **Mô tả:** `html:true` + không có DOMPurify/sanitizer. HTML thô từ `.md` vào DOM.
- **Tác động (đã đánh giá đúng residual, KHÔNG phải "critical XSS"):** inline `<script>`/`onerror=`/`<iframe>` **đều bị CSP chặn** ✓. Còn lọt: image-beacon (S2), CSS injection (S3), và `<form action="https://…">` (chỉ tay `form-action` **không** fallback về `default-src` → form submit ra ngoài được nếu người dùng bấm; giá trị thấp vì field tĩnh).
- **Fix:** Thêm `form-action 'none'` (và `frame-src 'none'` cho tường minh) vào CSP; cân nhắc DOMPurify allowlist thẻ để phòng thủ theo chiều sâu, không phụ thuộc hoàn toàn CSP.

### S3 · **Low-Medium** · [provider.ts:451](src/provider.ts#L451) (`style-src 'unsafe-inline'`)
- **Mô tả:** Cho phép `<style>`/`style="..."` từ `.md` không tin cậy.
- **Tác động:** UI-redress trong pane preview (overlay `position:fixed` che/giả nội dung, lừa click); `background-image:url(https://…)` là thêm vector phone-home. Không exfil được dữ liệu.
- **Fix:** Rủi ro thấp; khó bỏ `unsafe-inline` (cần cho render). Ít nhất tài liệu hóa; cân nhắc sanitize thuộc tính `style`/thẻ `<style>` trong nội dung `.md`.

### S4-residual · **Low** · [provider.ts:429-439](src/provider.ts#L429-L439) (`isInsideAllowedRoots`)
- **Mô tả:** `openLink` đã phòng thủ tốt; residual duy nhất: kiểm tra path bằng so chuỗi `startsWith`, **không resolve symlink**.
- **Tác động:** Nếu workspace có sẵn symlink trỏ ra ngoài (vd `data -> /`), `.md` độc `[x](data/etc/passwd)` sẽ vượt kiểm tra và `vscode.open` mở file ngoài workspace (người dùng thấy được, không exfil ngầm).
- **Fix:** `fs.realpath` resolve symlink trước khi kiểm tra thuộc allowed roots.

### S6 · **Low** · [provider.ts:39-43](src/provider.ts#L39-L43) (`localResourceRoots` gồm cả workspace)
- **Tác động:** `.md` dò tồn tại file cục bộ trong workspace qua `<img src="../secret.png">` (load được/không). Không đọc được nội dung (CSP chặn onload/onerror).
- **Fix:** Thu hẹp về `dist` + `documentDir` trừ khi thật sự cần ảnh liên-thư-mục.

### S7 · **Low** · [provider.ts:506-513](src/provider.ts#L506-L513) (`getNonce` dùng `Math.random`)
- **Tác động:** Nit best-practice. Về lý thuyết nonce đoán được, nhưng **được giảm nhẹ triệt để**: nội dung không tin cậy vào DOM qua `innerHTML` — trình duyệt không thực thi `<script>` chèn kiểu này bất kể nonce. Không có đường khai thác thực tế.
- **Fix:** `crypto.randomBytes(16).toString('base64url')` hoặc `crypto.randomUUID()` (Node 20 có sẵn).

### ✅ Đã phòng thủ tốt (không phải lỗi — có bằng chứng)
- **`openLink` (điểm mạnh nhất):** allowlist `SAFE_SCHEMES={http,https,mailto}` ([provider.ts:156](src/provider.ts#L156)), chặn `command:`/`vscode:`/`javascript:`/`file:`/`data:` ([:162](src/provider.ts#L162)); link tương đối chuẩn hóa `..` + chặn traversal, thêm `/` cuối chống bypass prefix sibling ([:434](src/provider.ts#L434)).
- **Paste:** chỉ đọc `text/plain`, KHÔNG lấy `text/html` từ clipboard, re-render qua markdown-it ([main.ts:335-341](media/webview/main.ts#L335-L341)).
- **Mermaid `securityLevel:'strict'`:** set thật ([mermaid.ts:31](media/webview/mermaid.ts#L31)), không chỉ comment.
- **Validate message host:** ép kiểu mọi field (`String(msg.text/href/query)`), không có auto-trigger từ nội dung `.md` ([provider.ts:67](src/provider.ts#L67)).
- **`applyMinimalEdit`:** chỉ ghi ngược chính document đang mở, không phải file tùy ý ([provider.ts:128-153](src/provider.ts#L128-L153)) — thuộc correctness, không phải security.
- **CVE (S11):** `npm audit` 0 lỗ hổng; các bản đang cài (`markdown-it 14.3.0`, `mermaid 11.16.0`, `katex 0.16.47`, `turndown 7.2.4`, `highlight.js 11.11.1`) đều đã vá.

---

## 2. 🟡 Performance

### P-01 · **High** · [main.ts:101-106,144](media/webview/main.ts#L101-L144), [provider.ts:51-65](src/provider.ts#L51-L65), [mermaid.ts:59-64](media/webview/mermaid.ts#L59-L64)
- **Mô tả:** Mỗi thay đổi document **từ bên ngoài webview** (gõ ở text editor cạnh bên, git, format-on-save) → host gửi ngay **toàn bộ text**, **không debounce** ([provider.ts:64](src/provider.ts#L64)) → `renderDocument()`: markdown-it re-parse cả tài liệu (KaTeX + hljs **đồng bộ**), `content.innerHTML = html` **dựng lại toàn bộ DOM**, `mermaid.render()` dựng lại **mọi** biểu đồ **không cache theo source**, gutter/search/toc refresh. Không diff theo block dù đã có sẵn `data-line` làm khóa diff lý tưởng. Mermaid đang render không bị hủy khi keystroke kế đến.
- **Tác động:** Gõ nhanh ở raw editor khi preview mở song song + tài liệu lớn (≥2K dòng)/nhiều mermaid: mỗi keystroke = full re-render + N lần `mermaid.render` → nghẽn main thread, SVG nhấp nháy.
- **Fix:** (1) Debounce `update` 100-250ms; (2) diff theo block dựa `data-line`; (3) cache Mermaid SVG/hljs/KaTeX theo hash source; (4) hủy render mermaid cũ khi có đợt mới.

### P-02 · **High** · [package.json](package.json) (`vscode:prepublish`), [esbuild.js:8,32](esbuild.js#L8), `dist/webview/main.js`
- **Mô tả:** `vscode:prepublish` chạy `node esbuild.js` **thiếu `--production`** → vsix ship bundle **chưa minify 9.37 MB**. Trong đó **~8 MB (85%) là Mermaid**, `import` **tĩnh** ([mermaid.ts:12](media/webview/mermaid.ts#L12)) nên load cả khi tài liệu không có biểu đồ.
- **Tác động:** Mỗi lần mở preview: Chromium parse/compile 9.4 MB JS → khởi động chậm, nhân với số tab (do `retainContextWhenHidden`).
- **Fix:** (1) `vscode:prepublish` → `node esbuild.js --production` (1 dòng, −60% ngay); (2) tách Mermaid ra chunk, `import()` động chỉ khi có `.language-mermaid`.

### P-03 · **Medium** · [main.ts:200-232](media/webview/main.ts#L200-L232), [pipeline.ts:396-493](media/webview/pipeline.ts#L396-L493), [gutter.ts:124-143](media/webview/gutter.ts#L124-L143)
- **Mô tả:** Turndown có debounce 250ms (tốt), nhưng mỗi nhịp `syncNow()`: `cloneNode(true)` toàn bộ #content → `prepareDomForSerialize` (`normalizeListDom` lặp tới 50 lần, mỗi lần nhiều `querySelectorAll`) → turndown O(cả tài liệu) → `refreshFromMarkdown` = **markdown-it parse lại lần thứ hai**. Chuỗi này chạy **trước** khi so `markdown === currentText` → chạy cả khi nội dung không đổi.
- **Tác động:** Tài liệu lớn: khựng nhẹ theo chu kỳ 250ms khi gõ.
- **Fix:** So sánh nội dung đổi TRƯỚC clone+turndown; cân nhắc `requestIdleCallback`; dài hạn: serialize theo dirty-block.

### P-04 · **Medium** · [main.ts:238-243](media/webview/main.ts#L238-L243), [pipeline.ts:502-523](media/webview/pipeline.ts#L502-L523)
- **Mô tả:** `fixOrphanNestedListItems()` chạy trên **mọi `input` không debounce**; quét `querySelectorAll('li')` toàn tài liệu, lặp tới 50 vòng.
- **Tác động:** O(tổng số li) cộng vào từng keystroke; rõ với list lớn/sâu.
- **Fix:** Giới hạn quét vào subtree quanh selection; hoặc chỉ full-scan sau delete/cut/undo.

### P-05 · **Medium** · [search.ts:368,103-136,223-246](media/webview/search.ts#L368)
- **Mô tả:** Refresh theo content có debounce (✓) nhưng gõ trong **ô tìm** thì `input → run()` **không debounce**. Mỗi `run()`: TreeWalker duyệt mọi text node + `buildOverview()` **xen kẽ đọc–ghi layout** (`getBoundingClientRect` ngay sau `appendChild`) → forced reflow từng match (tới 5000).
- **Tác động:** Gõ từ khóa ngắn trên tài liệu lớn → hàng nghìn forced reflow → khựng rõ.
- **Fix:** Debounce ô tìm ~100-150ms; tách pha đọc `getBoundingClientRect` trước rồi append (DocumentFragment); cache haystack giữa các lần gõ.

### P-06 · **Medium** · [provider.ts:23-24](src/provider.ts#L23-L24) (`retainContextWhenHidden`)
- **Đánh giá:** **Có lý do chính đáng** — #content là contenteditable, bỏ retain sẽ mất caret + undo stack khi tab ẩn/hiện. Đòn bẩy thực tế là **giảm footprint mỗi webview (fix P-02)** thay vì tắt cờ.

### P-07 · **Low-Medium** · [gutter.ts:145-146](media/webview/gutter.ts#L145-L146)
- **Mô tả:** `ResizeObserver` không throttle → mỗi thay đổi chiều cao dựng lại toàn bộ marker (đọc/ghi đã gom qua fragment, nhưng chưa gom callback).
- **Fix:** Coalesce qua `requestAnimationFrame`.

### P-08 · **Low** · [provider.ts:387-391](src/provider.ts#L387-L391), [prompt.ts:113-118](media/webview/prompt.ts#L113-L118)
- **Mô tả:** Mỗi query gợi ý link gọi `findFiles('**/*', …, 5000)` quét lại workspace từ đầu (đã có debounce 200ms + requestId, chạy ở host nên không block UI).
- **Fix:** Cache danh sách URI cho cả phiên prompt, chỉ re-score theo query.

### P-09 · **Low** · [esbuild.js:53-58](esbuild.js#L53-L58), `dist/webview/katex/` (1.2 MB, 60 font)
- **Mô tả:** Copy cả ttf/woff/woff2; webview Chromium chỉ cần woff2.
- **Fix:** Chỉ copy `*.woff2` + rewrite CSS (ưu tiên thấp).

### ✅ Đã tối ưu tốt (không phải lỗi)
- **Không leak listener/observer:** dùng event delegation trên #content bền vững; subtree rebuild bị vứt nguyên cụm → GC; chỉ 1 ResizeObserver, không MutationObserver/setInterval ([grep toàn bộ `media/webview`]).
- **Gõ TRONG webview không re-render** (chỉ external update); edit sync debounce 250ms + flush khi blur/hidden/⌘S.
- **Chống echo loop** 2 lớp host↔webview.
- **Search highlight** dùng CSS Custom Highlight API (không chèn `<mark>`).
- **highlight.js** dùng subset `lib/common`, không full build ([pipeline.ts:19](media/webview/pipeline.ts#L19)).

---

## 3. 🟢 Code Convention / Code Smell

**Định lượng:** `tsc --noEmit` sạch · `any`: **0** · `TODO/FIXME`: **0** · `console.*` production: **0** (chỉ trong test) · `strict` + `noImplicitReturns` + `noFallthroughCasesInSwitch` đã bật.

### C1 · **Medium** · God file [pipeline.ts](media/webview/pipeline.ts) (1027 dòng)
- **Smell:** Gộp ~7 nhóm trách nhiệm: cấu hình markdown-it, tùy biến render, hậu xử lý DOM (math/mermaid), chuẩn bị serialize + sửa list Chromium, tiện ích bảng, và turndown (`createTurndown` + 15 rule).
- **Fix:** Tách `render.ts` / `dom-postprocess.ts` / `dom-serialize-prep.ts` / `turndown.ts`; chuyển `fillSequenceColumn` sang module bảng; `hasAncestor`/escape helpers → `dom-portable.ts` dùng chung. Consumers chỉ cần đổi import path.

### C3 · **Medium** · Message contract "stringly-typed" 2 đầu · [provider.ts:67](src/provider.ts#L67), [main.ts:78-113](media/webview/main.ts#L78-L113)
- **Smell:** Không có type dùng chung; mỗi đầu khai báo hình dạng message độc lập theo chuỗi literal. Đổi tên/field một đầu → đầu kia lệch âm thầm, compiler không bắt.
- **Fix:** `shared/messages.ts` với 2 discriminated union `WebviewToHost` / `HostToWebview`; `switch(msg.type)` trên union ép xử lý đủ nhánh.

### C6 · **Medium** · Thiếu test cho host / message / security · [test/](test/)
- **Smell:** Chỉ có `roundtrip.ts` + fixtures. Không test `applyMinimalEdit`, `openLink` allowlist, `searchWorkspaceFiles`, message-contract.
- **Fix:** Thêm unit test cho các hàm thuần logic (`applyMinimalEdit`, `openLink` scheme/traversal, `normalizeForSearch`, `relativePath`) — không cần VS Code runtime.

### C5 · **Medium-Low** · Chưa có ESLint
- **Fix:** ESLint flat config + `@typescript-eslint` + `eslint-plugin-security`; bật `no-floating-promises`, `no-unused-vars`.

### C9 · **Low** · Hằng debounce/delay rải rác + magic literal
- Debounce cùng bậc lặp ở nhiều module (`main.ts:63` 250, `search.ts:38` 200, `toc.ts:28` 250…); literal chưa đặt tên (`main.ts:558` 200, `dom-utils.ts:63` 6000, `provider.ts` 300/700/150/250 timing chờ Claude).
- **Fix:** Gom hằng dùng chung; đặt tên mọi literal ms; chú thích rõ các delay chờ Claude là heuristic mong manh.

### C4 · **Low** · [tsconfig.json](tsconfig.json) tắt `noUnusedLocals`
- **Fix:** Bật `noUnusedLocals: true` + `noUnusedParameters: true` (code đã dùng quy ước `_prefix`). Rẻ, không đổi runtime.

### C2 · **Low** · Trùng lặp bọc list bằng `execCommand('insertHTML')` · [input-rules.ts:127-168](media/webview/input-rules.ts#L127-L168) ≈ [:376-422](media/webview/input-rules.ts#L376-L422)
- **Fix:** Tách helper `insertListItemViaExec(innerHtml, listTag, mode)`; hai hàm gọi tự lo selection + dọn `<p>` riêng.

### C8 · **Low** · Nuốt lỗi rộng + không có kênh log · [provider.ts:298](src/provider.ts#L298)
- **Smell:** `try` bao toàn bộ `addToClaudeContext` + `catch {}` **nuốt mọi lỗi không log**; code production không có logging nào → khó chẩn đoán khi tích hợp Claude Code hỏng.
- **Fix:** Thu hẹp `try` hoặc log qua `vscode.OutputChannel`/`console.error` trước khi fallback.

### C-new · **Low** · Trùng `escapeHtml`/`escapeAttr` · [pipeline.ts:271-277](media/webview/pipeline.ts#L271-L277) vs [dom-utils.ts:10,14](media/webview/dom-utils.ts#L10)
- **Fix:** Đưa cặp escape thuần chuỗi vào module portable dùng chung (cùng chỗ `hasAncestor` khi tách C1).

### ✅ Không phải vấn đề (có bằng chứng)
- **C7 (file .vsix):** `.gitignore` **đã có** `*.vsix`; `git ls-files '*.vsix'` = **0**; không commit nào từng đụng `.vsix`. Chỉ là artifact build cục bộ — **không phải smell git**.
- Không `any`/`TODO`/`console` lọt production; comment giải thích workaround Chromium/execCommand rất tốt; không dead code rõ rệt.

---

## 4. Lộ trình đề xuất

| Đợt | Việc | Findings | Effort |
|---|---|---|---|
| **Quick win** | `--production` cho prepublish; siết CSP (`img-src`, `form-action`) | P-02(1), S2, S1 | Rất thấp |
| **Hiệu năng** | Debounce update + cache mermaid; đảo check trong `syncNow`; debounce ô tìm | P-01, P-03, P-05, P-04 | Trung bình |
| **Cấu trúc** | Tách `pipeline.ts`; type dùng chung cho message; thêm ESLint + `noUnusedLocals` | C1, C3, C5, C4 | Trung bình |
| **Chất lượng** | Test cho host/security; log lỗi; tách mermaid `import()` động; resolve symlink openLink | C6, C8, P-02(2), S4 | Cao hơn |
| **Nit** | localResourceRoots, nonce CSPRNG, dedup escape/helper, KaTeX woff2, ResizeObserver rAF | S6, S7, C2, C-new, P-09, P-07 | Thấp |

---
_Báo cáo sinh từ review đa tác nhân theo [Review Plan.md](Review%20Plan.md). Mỗi finding đã xác minh trên mã nguồn `v0.5.14`._
