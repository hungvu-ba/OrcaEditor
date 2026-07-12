# Requirement: Highlight & Tìm xuyên file khi select text

> **Ngày lập:** 2026-07-12 **Trạng thái:** *Đã chốt requirement qua brainstorm — chưa triển khai code.* **Phạm vi:** Orca Editor (`media/webview/`, `src/provider.ts`)

Tài liệu này mô tả 1 requirement gồm **2 tính năng liên quan nhau**, kích hoạt khi user select text trong preview:

-   **A. Highlight trong file hiện tại** — tự động, không cần thao tác thêm.
-   **B. Tìm xuyên file trong project** — thủ công, bấm icon để chạy.

Mục tiêu: giúp user tra cứu nhanh thông tin liên quan tới đoạn text đang đọc, mà không phải tự mở Ctrl+F hay tự đi tìm file khác.

---

## A. Highlight trong file hiện tại (tự động)

**Trigger:** ngay khi selection ổn định (không cần bấm gì thêm) và độ dài selection ≥ 2 ký tự (không tính khoảng trắng/dấu câu thuần).

**Hành vi:**

-   Tự động highlight mọi vị trí khác trong tài liệu hiện tại khớp với text đã chọn, so khớp **không phân biệt hoa/thường**.
-   Dùng CSS Custom Highlight API, tái dùng logic quét segment theo block boundary đã có trong [search.ts](media/webview/search.ts) (nên tách phần "tìm match trong `#content`" thành hàm dùng chung giữa Ctrl+F search và tính năng này, tránh trùng code).
-   Dùng highlight name riêng (khác `search-match` / `search-current`) để không xung đột màu khi Find box (Ctrl+F) đang mở cùng lúc.

**Xoá highlight khi:** selection bị huỷ, user click nơi khác, hoặc Esc.

**Không bao gồm (out of scope cho bản đầu):** không có nút prev/next điều hướng riêng cho phần này (khác với Ctrl+F search).

---

## B. Tìm xuyên file trong project (thủ công, bấm icon)

**Trigger:**

-   Icon nhỏ (kính lúp) hiện nổi cạnh cuối vùng chọn, **sau một khoảng delay debounce** (đề xuất **250ms**, khớp `REBUILD_DEBOUNCE_MS`/`SYNC_DEBOUNCE_MS` đang dùng trong [constants.ts](media/webview/constants.ts)) kể từ lúc selection đứng yên — tránh icon nhấp nháy khi đang kéo chuột chọn text hoặc select chỉ để copy.
-   Cơ chế: lắng nghe `selectionchange`, mỗi lần đổi thì reset timer; chỉ hiện icon khi không có thay đổi trong khoảng debounce đó. Không cần listener `mouseup` riêng — cách này tự xử lý cả kéo chuột lẫn chọn bằng bàn phím (Shift+Arrow).
-   Search **chỉ chạy khi user bấm icon** — không auto-search, không debounce-live-search.
-   Ẩn icon khi: selection bị xoá, user gõ phím, scroll xa vị trí selection, hoặc click nơi khác.
-   Cần fallback bàn phím (phím tắt khi có selection) cho user dùng keyboard-only, vì icon-click thuần chuột không accessible.

**Kết quả hiển thị:** popover nổi ngay dưới/cạnh icon.

-   Header: số lượng match tìm thấy + dropdown nhỏ đổi phạm vi tìm ngay tại chỗ (Markdown files / All files) — không cần vào Settings.
-   Danh sách kết quả nhóm theo file: tên file, đường dẫn tương đối, snippet ngữ cảnh (~1 dòng trước/sau) với từ khớp được highlight.
-   Giới hạn hiển thị (vd tối đa 20 kết quả / 5 file đầu), có "Xem thêm trong Search panel" để đẩy sang panel Search chuẩn của VS Code nếu cần xem hết.
-   Empty state: "Không tìm thấy trong project" + gợi ý đổi phạm vi sang All files.
-   **File đang mở hiện tại bị loại trừ hoàn toàn** khỏi kết quả (không chỉ gắn nhãn).
-   Click 1 kết quả → mở file đó (Orca Editor nếu là `.md`, editor thường nếu không), nhảy tới đúng vị trí match qua `vscode.commands.executeCommand('vscode.open', uri, { selection })`.

**Phạm vi tìm (setting `orcaEditor.crossFileSearch.scope`):**

-   `"markdown"` (default) — chỉ file `.md`/`.markdown` trong workspace.
-   `"allFiles"` — toàn bộ file text trong workspace.
-   ~~`"headingsOnly"`~~ — đã loại bỏ khỏi scope (quyết định chốt: bỏ heading-only mode).
-   Tôn trọng `.gitignore`; loại trừ `node_modules`, `dist`, ảnh, binary.
-   Case-insensitive theo mặc định.
-   File đang mở nhưng chưa save (dirty): search theo nội dung buffer hiện tại (`vscode.workspace.textDocuments`), không chỉ nội dung trên disk.

---

## Kỹ thuật triển khai (sơ bộ)

-   **Webview** (`media/webview/`): thêm module mới (vd `cross-file-search.ts`) lắng nghe `selectionchange`, tính vị trí icon qua `Range.getBoundingClientRect()`. Khi click icon → `postMessage` sang extension host qua [vscode-api.ts](media/webview/vscode-api.ts).
-   **Extension host** ([provider.ts](src/provider.ts)): nhận message, dùng `vscode.workspace.findFiles` theo glob tương ứng scope, đọc nội dung (ưu tiên `textDocuments` đang mở, fallback `workspace.fs.readFile`), scan tìm match, cắt snippet ngữ cảnh, trả kết quả về webview.
    -   Cap số file/kích thước quét để tránh treo trên project lớn (vd giới hạn 500 file hoặc dùng `maxResults` của `findFiles`).
    -   Không có API `findTextInFiles` ổn định trong VS Code stable API → tự scan bằng regex/`String.includes`, không phụ thuộc ripgrep nội bộ (fragile).
-   Thêm hằng số debounce mới vào [constants.ts](media/webview/constants.ts), cùng nhóm với `REBUILD_DEBOUNCE_MS`/`TABLE_TOOLBAR_HIDE_MS`, ví dụ `CROSS_FILE_ICON_DEBOUNCE_MS = 250`.

---

## Quyết định cuối (đã chốt)

-   **Ngưỡng độ dài tối thiểu** để trigger cả 2 tính năng (A và B): **≥3 ký tự** (không tính khoảng trắng/dấu câu thuần).
-   **Màu highlight của phần A**: cùng tông vàng với `search-match` nhưng **nhạt hơn** để phân biệt với Ctrl+F — đề xuất `rgba(255, 197, 61, 0.18)` (giảm opacity từ 0.35 → 0.18), tên highlight riêng `select-match`.
-   **Debounce hiện icon (phần B): 250ms** — đã chốt ban đầu, nhưng **đã bị superseded bởi quyết định C3** (mục "Cải tiến vòng 2"): giá trị thực tế hiện tại là **750ms** (`CROSS_FILE_ICON_DEBOUNCE_MS`, constants.ts), kèm listener `copy`/`cut`/Backspace-Delete để lọc đúng ý định thay vì chỉ dựa vào con số debounce.

---

## Implementation Task List

### 1\. Constants & shared utils

-   [x]  `constants.ts`: thêm `MIN_SELECT_LENGTH = 3` và `CROSS_FILE_ICON_DEBOUNCE_MS = 250`.
-   [x]  Tách hàm quét match theo block boundary trong [search.ts](media/webview/search.ts) thành hàm dùng chung (vd `match-utils.ts`), giữ nguyên hành vi hiện tại của Ctrl+F search khi refactor.

### 2\. CSS ([editor.css](media/editor.css))

-   [x]  Thêm `::highlight(select-match) { background-color: rgba(255, 197, 61, 0.18); }` cạnh block `search-match`/`search-current` hiện có.
-   [x]  Style icon nổi (kính lúp) + popover: vị trí, theme-aware (sáng/tối), z-index không đụng `#search-overview`/`#search-box`.

### 3\. Feature A — highlight trong file hiện tại

-   [x]  Module mới `media/webview/select-highlight.ts`: lắng nghe `selectionchange`, áp ngưỡng `MIN_SELECT_LENGTH`, dùng hàm match dùng chung để tìm & đăng ký `Highlight` tên `select-match`.
-   [x]  Xoá highlight khi selection bị huỷ / click nơi khác / Esc.
-   [x]  Wire init vào [main.ts](media/webview/main.ts) cạnh `initSearch`.

### 4\. Feature B — icon + popover tìm xuyên file (webview side)

-   [x]  Module mới `media/webview/cross-file-search.ts`: debounce 250ms trên `selectionchange`, áp ngưỡng `MIN_SELECT_LENGTH`, tính vị trí icon qua `Range.getBoundingClientRect()`.
-   [x]  Ẩn icon khi selection đổi/mất, click nơi khác, scroll xa, gõ phím.
-   [x]  Popover: header (số kết quả + dropdown scope Markdown/All files), danh sách kết quả nhóm theo file + snippet, empty state, link "xem thêm trong Search panel".
-   [x]  Phím tắt fallback cho keyboard-only user — đã chọn `Ctrl+Shift+F` / `Cmd+Shift+F` (mnemonic giống "Find in Files" của VS Code), chỉ kích hoạt khi có selection hợp lệ.
-   [x]  Gửi/nhận message qua [vscode-api.ts](media/webview/vscode-api.ts).

### 5\. Message contract

-   [x]  Mở rộng src/shared/messages.ts: thêm type request/response cho `crossFileSearch:request` và `crossFileSearch:openResult` (kèm `crossFileSearch:openInSearchPanel` cho link "xem thêm trong Search panel").

### 6\. Extension host ([provider.ts](src/provider.ts))

-   [x]  Handler `crossFileSearch:request`: `findFiles` theo scope (glob theo setting/`scope` override từ dropdown), loại trừ file hiện tại, tôn trọng `.gitignore`/exclude mặc định, cap số file quét (vd 500).
-   [x]  Đọc nội dung: ưu tiên `vscode.workspace.textDocuments` (buffer đang mở/dirty) trước, fallback `workspace.fs.readFile`.
-   [x]  Scan case-insensitive, cắt snippet ngữ cảnh, cap tổng kết quả trả về (vd 20 kết quả / 5 file).
-   [x]  Handler `crossFileSearch:openResult`: mở file qua `vscode.commands.executeCommand('vscode.open', uri, { selection })`, dùng Orca Editor cho `.md`.

### 7\. Settings

-   [x]  `package.json` → `contributes.configuration`: thêm `orcaEditor.crossFileSearch.scope` (enum `markdown` default | `allFiles`).

### 8\. Kiểm thử thủ công (trước khi coi là xong)

> Đã verify bằng máy: `tsc --noEmit`, `eslint`, `esbuild` production build, và `npm run test:unit` (48/48, đã bổ sung 4 message contract mới) đều pass. Các mục dưới đây cần mở Extension Development Host (F5) để tự tay kiểm tra tương tác UI thực tế — chưa thực hiện được trong môi trường này.

-   [ ]  Select text có nhiều chỗ trùng trong cùng file → highlight nhạt hơn Ctrl+F, đúng case-insensitive.
-   [ ]  Icon chỉ hiện sau ~750ms khi selection đứng yên, không nhấp nháy lúc kéo chuột.
-   [ ]  Đổi scope Markdown ⇄ All files trong popover hoạt động đúng.
-   [ ]  File hiện tại không xuất hiện trong kết quả cross-file.
-   [ ]  Click kết quả mở đúng file, đúng vị trí.
-   [ ]  File chưa save (dirty) vẫn phản ánh đúng nội dung khi search.

### 9\. Sau khi code xong

-   [x]  Thêm dòng vào Update History.md theo quy tắc CLAUDE.md (fix/feature, ≤30 từ).

---

## C. Cải tiến vòng 2 (từ `test/bug.md`) — đang brainstorm, CHƯA chốt

> **Nguồn:** mục "Cross file search" trong [test/bug.md](test/bug.md), 6 dòng. Đối chiếu với source hiện tại (`search.ts`, `select-highlight.ts`, `cross-file-search.ts`, `provider.ts`, `constants.ts`, `editor.css`) tại thời điểm brainstorm. Mỗi item dưới đây brainstorm riêng biệt, có câu hỏi mở cần user trả lời trước khi đưa vào Implementation Task List mới.

### C1. Overview strip bên phải cho Feature A (highlight khi select)

**Bug.md:** *"khi select text thì ngoài highlight matched text thì còn cần highlight ở mép bên phải những dòng có matched text, giống tính năng khi dùng Cmd + F"*

**Hiện trạng:** Ctrl+F đã có `#search-overview` (dải tick bên phải, click để nhảy tới match — search.ts:73-77, 160-187). Feature A (`select-highlight.ts`) hiện **chỉ paint highlight trong `#content`, không có overview strip nào**.

**Brainstorm:**
- Tái dùng gần như nguyên `buildOverview()` từ search.ts, tách vào `match-utils.ts` thành hàm dùng chung (đúng tinh thần "tránh trùng code" đã đặt ra ở mục A của requirement gốc).
- DOM container riêng (vd `#select-overview`), tick màu khác `#search-overview` để phân biệt khi cả hai cùng hiện.

**Phản biện / rủi ro:**
- **Chồng UI:** Nếu Ctrl+F đang mở *và* user đang select text cùng lúc → 2 dải tick cùng vị trí bên phải màn hình, dễ rối mắt. Cần quyết định: hiện song song (phân biệt màu/offset ngang) hay ẩn bớt cái nào.
- **Performance:** Feature A tính lại trên **mọi** `selectionchange` (chỉ coalesce bằng `requestAnimationFrame`, không debounce) — kể cả lúc đang kéo chuột. Build tick DOM + `getBoundingClientRect()` cho từng match trong lúc kéo chuột (file dài, nhiều match) có thể giật, nặng hơn nhiều so với Ctrl+F (chỉ build khi mở hộp thoại/gõ, đã debounce).
- **Có click-to-jump không?** Nếu strip cũng cho click để nhảy tới match, thực chất tái tạo lại "điều hướng" — mà requirement gốc dòng 26 đã chốt **"không có nút prev/next... nằm ngoài phạm vi"** cho Feature A. Cần làm rõ đây chỉ là chỉ báo trực quan hay có tương tác.

**Đã chốt (trả lời của user):**
1.  **Click-to-jump: KHÔNG.** Overview strip của Feature A chỉ là chỉ báo trực quan, không tương tác (không tick-to-jump, không nút prev/next) — giữ đúng phạm vi "out of scope" của requirement gốc.
2.  **Khi Ctrl+F đang mở: Feature A tắt hẳn hoàn toàn — cả highlight paint (`select-match`) lẫn overview strip**, không chỉ riêng strip. Xác nhận đúng diễn giải ban đầu. Lúc `#search-box` đang mở, `select-highlight.ts` tạm ngưng hoạt động hoàn toàn (không paint, không build strip), tránh 2 lớp highlight + 2 dải tick chồng nhau cùng lúc.

**Safeguard hiệu năng cho file dài / nhiều match — đã chọn hướng (D), không kết hợp (A)/(B)/(C):**

> Bối cảnh: Feature A tính lại trên *mọi* `selectionchange` (kéo chuột bắn liên tục), nên safeguard cần rẻ — không được tính toán nặng (đếm dòng, quét toàn doc) lặp lại trên từng sự kiện. 4 phương án đã cân nhắc: (A) ngưỡng số dòng tĩnh tắt cứng cả tính năng, (B) cap top-N item từ đầu file, (C) ngưỡng động theo số match của riêng truy vấn hiện tại, (D) throttle tần suất build overview-strip. Đã chọn **(D)**.

**(D) — đã chốt:** Native CSS Custom Highlight API (`CSS.highlights.set`) rất rẻ (không thao tác DOM, chỉ đăng ký Range) nên phần **paint highlight giữ nguyên tần suất hiện tại** (mỗi `requestAnimationFrame`, không đổi). Phần đắt thực sự là build tick DOM cho overview strip (tạo node + `getBoundingClientRect()` mỗi match) — tách riêng: overview-strip chỉ rebuild tối đa 1 lần mỗi khoảng throttle trong lúc đang kéo chuột liên tục, thay vì mỗi frame.

- Đề xuất giá trị mặc định: `SELECT_OVERVIEW_THROTTLE_MS = 150` (nằm giữa dải 150–200ms đã brainstorm, cùng bậc với các debounce khác trong `constants.ts` như `REFRESH_DEBOUNCE_MS = 200`). Có thể chỉnh khi thấy giật/lag thực tế lúc test tay.
- **Rủi ro còn sót lại của (D):** throttle chỉ giảm *tần suất* rebuild, không giới hạn *kích thước* mỗi lần rebuild. Nếu 1 file cực dài có hàng nghìn match cho 1 truy vấn (vd select 1 từ rất phổ biến), mỗi lần rebuild dù đã throttle vẫn phải tạo hàng nghìn DOM node + đọc `getBoundingClientRect()` — bản thân 1 lần rebuild đó có thể vẫn giật dù chỉ chạy mỗi 150ms thay vì mỗi frame. Vì user đã chọn thuần (D) (không kết hợp B/C), đề xuất bổ sung nhỏ ở **tầng implementation** (không phải mở lại quyết định): cap cứng số tick element build mỗi lần rebuild ở mức an toàn (vd 500 — chỉ là giới hạn kỹ thuật để tránh 1 lần rebuild quá nặng, khác với việc "tắt tính năng" của phương án B đã không chọn). Sẽ implement kèm log/note khi bị cắt để không silent-cap.

**Đã implement (2026-07-12):** tách `buildOverviewTicks()` dùng chung vào `match-utils.ts` (search.ts refactor lại để gọi, hành vi Ctrl+F không đổi); thêm `#select-overview` + `.select-tick` (không click-to-jump) trong `select-highlight.ts`; `SearchController.isOpen()` mới, Feature A tắt hẳn paint+strip khi Ctrl+F mở; throttle build strip 150ms (`SELECT_OVERVIEW_THROTTLE_MS`, không đụng tần suất paint rAF), cap 500 tick kèm `console.warn` khi bị cắt. Đã verify `tsc`/`eslint`/`test:unit` (48/48 tại thời điểm đó) pass. Chưa test tay F5.

---

### C2. Icon tự ẩn sau 3 giây nếu user không bấm

**Bug.md:** *"Button search cần ẩn đi sau 3s nếu user không chọn."*

**Hiện trạng:** Icon hiện tại chỉ ẩn khi: đổi selection, gõ phím, scroll >80px, click ra ngoài (cross-file-search.ts:135-137, 345-354, 374-381). Không có timer tự ẩn theo thời gian đứng yên.

**Brainstorm:** Thêm `setTimeout` 3s khi icon vừa hiện (`showIconForSelection`), `hideIcon()` khi hết giờ; clear timer khi selection đổi/click/scroll đã có sẵn logic ẩn.

**Phản biện / rủi ro:**
- **Race với hover:** Nếu không pause timer khi chuột đang hover/focus icon, icon có thể biến mất ngay lúc user đang di chuột tới để bấm — lỗi UX kinh điển (tooltip biến mất trước khi kịp click). Bắt buộc phải pause-on-hover/focus, resume khi rời chuột.
- **Cộng dồn với C3:** Nếu áp cả debounce hiện icon dài hơn (C3) *và* auto-hide 3s, tổng thời gian từ lúc select xong tới lúc icon biến mất mất hẳn có thể chỉ còn vài giây để nhận ra + di chuột + bấm — cần tính tổng thời lượng trải nghiệm, không chỉ từng số riêng lẻ.
- **Accessibility:** Phím tắt `Ctrl/Cmd+Shift+F` không phụ thuộc icon nên không bị chặn hoàn toàn, nhưng user thao tác chuột chậm (motor-impaired) có thể không đủ 3s để phản ứng.

**Đã chốt (trả lời của user):**
1.  **Đếm từ lúc icon hiện** — timer 3000ms bắt đầu ngay khi `showIconForSelection()` chạy.
2.  **Pause khi hover/focus, và RESET (không phải resume) khi rời hover/blur** — khi chuột đang hover hoặc icon có focus (vd Tab tới bằng bàn phím), timer tạm dừng đếm. Khi chuột rời khỏi icon / icon mất focus, timer **chạy lại từ đầu 3000ms** (không cộng dồn phần đã trôi trước đó) — cho user đủ thời gian đọc/quyết định lại mỗi lần quay lại icon, thay vì bị cắt ngang bởi phần thời gian đã "tiêu" từ trước lúc hover.
3.  **Không dùng phím tắt cho cơ chế này** — timer 3s chỉ áp dụng cho icon (đường chuột). Phím tắt `Ctrl/Cmd+Shift+F` (đường bàn phím, độc lập với icon) không bị ảnh hưởng và không tham gia vào việc pause/reset — luôn hoạt động bất kể icon đã tự ẩn hay chưa. *(Nếu ý bạn là khác — vd không cần fallback phím tắt nữa — cần nói rõ hơn, vì phím tắt đang là cơ chế accessibility chính cho user không dùng chuột theo yêu cầu gốc dòng 38.)*

**Lưu ý implementation:** timer 3s là cơ chế **bổ sung** vào các điều kiện ẩn icon đã có (đổi selection, gõ phím, scroll >80px, click ra ngoài — cross-file-search.ts:135-137, 345-354, 374-381), không thay thế chúng; các trigger ẩn tức thời đó vẫn giữ nguyên và nên clear timer 3s khi chúng kích hoạt (tránh timer cũ chạy ngầm rồi gọi `hideIcon()` thừa sau khi icon đã ẩn vì lý do khác).

**Đã implement (2026-07-12):** `ICON_AUTO_HIDE_MS = 3000` (constants.ts), timer khởi động trong `showIconForSelection()`, clear tập trung trong `hideIcon()` (mọi nhánh ẩn icon đi qua đây nên không cần rải clear ở 5 chỗ). Pause qua `mouseenter`/`focus`, reset đủ 3000ms qua `mouseleave`/`focusout`. Phím tắt Ctrl/Cmd+Shift+F không đổi, độc lập hoàn toàn. Đã verify `tsc`/`eslint`/`test:unit` pass. Chưa test tay F5.

---

### C3. Tăng debounce hiện icon 250ms → 2000ms

**Bug.md:** *"Tăng delay time button xuất hiện lên 2s từ khi user select text."*

**Hiện trạng — LƯU Ý:** đây không phải yêu cầu mới mà là **đảo ngược một quyết định đã chốt và đã code**. Requirement gốc (mục "Quyết định cuối") ghi rõ *"Debounce hiện icon (phần B): 250ms — đã chốt"*, đã implement `CROSS_FILE_ICON_DEBOUNCE_MS = 250` (constants.ts:49) và đã tick ở Task List mục 4.

**Brainstorm:** Đổi giá trị hằng số, hoặc — thay vì tăng debounce cứng — chuyển điều kiện hiện icon sang "chờ tới khi buông chuột (`mouseup`) rồi mới đếm debounce ngắn", vốn ít đánh đổi độ trễ hơn so với kéo dài debounce cố định lên gấp 8 lần.

**Phản biện / rủi ro:**
- Cần hỏi lại **lý do đổi** trước khi sửa số: 250ms vốn được chọn để tránh icon nhấp nháy khi đang kéo chuột (requirement gốc dòng 34). Nếu lý do thực sự là tránh icon hiện ra khi user chỉ select để copy — thì vấn đề đó có thể giải quyết gọn hơn (vd dựa vào `mouseup`) thay vì kéo debounce lên 2s.
- 2s là khoảng lặng khá dài giữa hành động (select) và phản hồi (icon hiện) — dễ khiến user tưởng tính năng "không hoạt động" và bỏ đi trước khi icon kịp xuất hiện, đặc biệt nếu cộng dồn với auto-hide 3s ở C2.
- Vì đây là số đã "chốt" trong tài liệu chính thức + đã có test case liên quan ("Icon chỉ hiện sau ~250ms... không nhấp nháy lúc kéo chuột" — mục 8 Task List), đổi số này cần user xác nhận rõ ràng, tách biệt khỏi các feature mới khác.

**Lý do đổi (trả lời của user):** 250ms quá nhanh, khiến các thao tác khác không liên quan tới search — select để copy, select để xoá (Backspace/Delete) — cũng vô tình làm icon hiện lên.

**Phản biện thêm về con số 2000ms — tăng debounce không thực sự giải quyết đúng nguyên nhân:**
- **Gốc vấn đề không phải "debounce ngắn" mà là "không phân biệt được ý định".** Debounce chỉ gom các sự kiện `selectionchange` bắn liên tục khi đang kéo chuột thành 1 lần tính — nó không biết được lần select đó là để search, để copy, hay để xoá. Tăng số từ 250ms lên 2000ms chỉ trì hoãn việc hiện icon, không loại trừ được trường hợp copy/xoá; nó chỉ làm giảm *tần suất gặp phải* vấn đề (vì ít selection nào "đứng yên" đủ 2s), chứ không triệt tiêu được nó.
- **Copy thường không tự xoá selection.** Sau khi user bấm Ctrl+C/Cmd+C, trình duyệt **không** tự động huỷ vùng chọn — selection vẫn còn đó. Nếu user không di chuyển chuột/gõ phím ngay sau khi copy (rất phổ biến: copy xong, đọc tiếp, rồi mới làm gì đó), debounce dù là 250ms hay 2000ms **đều vẫn sẽ hiện icon** sau khi hết giờ, vì bản thân sự kiện copy không hề được lắng nghe/loại trừ ở đâu trong code hiện tại (`cross-file-search.ts` chỉ nghe `selectionchange`, `keydown`, `scroll`, không nghe `copy`/`cut`). Vậy nên **tăng con số không sửa được đúng gốc rễ** mà bug.md mô tả.
- **Đánh đổi bất lợi cho đúng use case chính (search):** 2000ms là gấp 8 lần con số gốc, vượt xa ngưỡng ~1s mà người dùng bắt đầu cảm thấy UI "phản hồi chậm/không liền mạch" với thao tác vừa làm. Việc này làm chậm trải nghiệm của user *thực sự* muốn search (majority use case) để giảm nhẹ (chứ không dứt điểm) phiền toái của use case phụ (copy/xoá).
- **Cộng dồn với C2:** 2000ms chờ hiện + 3000ms tự ẩn (C2) = ~5s trọn vòng đời icon cho *mọi* lần select đủ dài, kể cả select-để-copy/xoá — vấn đề gốc (icon hiện sai lúc) vẫn y nguyên, chỉ dịch thời điểm nó xảy ra.

**Đề xuất thay thế (giải quyết đúng nguyên nhân thay vì chỉnh số):**
- Lắng nghe sự kiện `copy` / `cut` trên `#content` → khi bắt được, coi như "không phải ý định search", huỷ timer debounce đang chờ hoặc ẩn icon nếu đã hiện, bất kể debounce đang là bao nhiêu ms.
- Lắng nghe `keydown` Backspace/Delete **khi đang có selection active** (trước khi selection bị xoá) → cũng coi là tín hiệu "không phải search", huỷ timer/ẩn icon tương tự.
- Giữ debounce ở mức gần với 250ms gốc (hoặc tăng nhẹ, vd 400–500ms, đủ để không tăng cảm giác trễ) vì bản thân debounce không phải là công cụ đúng để lọc ý định — 2 listener trên mới là cơ chế lọc đúng chỗ.

**Yêu cầu bổ sung của user — vị trí & hành vi hiển thị icon khi select (kèm ảnh minh hoạ):**

> *"khi select cần cho icon làm theo kiểu như hình đính kèm, hiển thị lên đúng chỗ text được select và ko floating theo scroll."*

**Đối chiếu code hiện tại:** `.cross-file-search-icon` dùng `position: fixed` (editor.css:759), toạ độ tính 1 lần từ `getBoundingClientRect()` (viewport-relative) tại thời điểm `showIconForSelection()` (cross-file-search.ts:153-162) — **không tính lại khi cuộn trang**. Trong khoảng cuộn 0–80px (`SCROLL_HIDE_THRESHOLD_PX`), icon đứng yên tại 1 điểm cố định trên màn hình trong khi đoạn text đã chọn trôi đi bên dưới nó → đúng hiện tượng "floating theo scroll" mà user mô tả (icon tách rời khỏi vị trí text thực tế cho tới khi vượt ngưỡng 80px và bị ẩn).

**Brainstorm hướng sửa:** đổi icon sang định vị theo **toạ độ tài liệu** thay vì toạ độ viewport — dùng `rect.top + window.scrollY` / `rect.left + window.scrollX` (giống cách `select-highlight`/`search.ts` tính vị trí tick trong `buildOverview()`) và `position: absolute` thay vì `fixed`. Khi đó icon nằm trong luồng tài liệu, tự cuộn cùng nội dung — bám đúng vị trí text đã chọn ở mọi thời điểm, không cần logic `SCROLL_HIDE_THRESHOLD_PX`/listener `scroll` để ẩn icon vì lệch vị trí nữa (có thể bỏ hẳn đoạn này, đơn giản hoá code).

**Đã chốt (trả lời của user, phần 1 — con số & cơ chế lọc ý định):**
1.  **Đồng ý hướng thay thế** — lắng nghe `copy`/`cut`/Backspace-Delete-khi-có-selection để huỷ timer/ẩn icon, thay vì chỉ dựa vào con số debounce để lọc ý định.
2.  **Debounce = 750ms** (không phải 250ms gốc, cũng không phải 2000ms đề xuất ban đầu) — user chọn mức trung gian này làm thêm 1 lớp đệm thời gian, cho user đủ khoảng lặng để thao tác xoá/copy/cut *trước khi* icon kịp hiện, cộng thêm (không thay thế) 2 listener `copy`/`cut`/Backspace-Delete ở trên. Cần cập nhật lại `CROSS_FILE_ICON_DEBOUNCE_MS` (constants.ts:49) từ `250` → `750`, và sửa lại dòng "đã chốt: 250ms" ở mục "Quyết định cuối" + test case liên quan ở Task List mục 8 cho khớp.

---

**Phần 2 — Vị trí icon: giữ nguyên toạ độ khi xuất hiện, neo theo đầu/cuối dòng hoặc dòng trống gần nhất**

**Yêu cầu của user (kèm ảnh minh hoạ — dòng "Bug 2 — Heading H1/H2/H3..." với chữ "trỏ" đang được chọn):**
> Vị trí xuất hiện **không chèn vào text** — nên ở đầu hoặc cuối dòng tuỳ vị trí select gần bên nào hơn. Cụ thể: xuất hiện ở cuối dòng có selected text; hoặc xuất hiện ở dòng trống gần nhất phía trên/dưới đoạn văn (paragraph) chứa selected text.

**Phản biện:**
- **"Cuối dòng" bị mơ hồ khi dòng bị word-wrap.** Editor này wrap chữ theo chiều rộng viewport (`wordWrap` config đọc trong `resolveCustomTextEditor`, provider.ts:155) — "dòng" mà user nhìn thấy trên màn hình (visual line, 1 đoạn `Range.getClientRects()`) khác với "dòng" ở cấp block (`<p>`/`<li>`/`<h#>`). Nếu selection nằm giữa 1 đoạn văn dài bị wrap thành nhiều dòng hiển thị, "cuối dòng" là cuối dòng-hiển-thị-hiện-tại (thường sát mép phải content, không có khoảng trống để chèn icon 26px mà không tràn/đè lên nội dung khác) hay cuối cả khối đoạn văn? Cần định nghĩa rõ để tránh icon bị cắt/đè khi selection ở giữa đoạn dài.
- **Selection nhiều dòng:** nếu vùng chọn tự nó trải dài qua 2+ dòng hiển thị (hoàn toàn có thể xảy ra, không có giới hạn 1-dòng nào ở `MIN_SELECT_LENGTH`), quy tắc "đầu hoặc cuối dòng, tuỳ gần bên nào hơn" cần biết dùng dòng đầu hay dòng cuối của vùng chọn làm mốc — chưa có câu trả lời rõ trong yêu cầu.
- **"Dòng trống gần nhất" không phải lúc nào cũng tồn tại.** Đây là editor WYSIWYG render ra HTML, không phải render trực tiếp theo dòng trống trong markdown source — bên trong 1 list, table cell, blockquote, hoặc đoạn văn đầu/cuối tài liệu, có thể **không có dòng trống liền kề nào** để neo vào (khoảng cách giữa các phần tử chỉ là margin/padding CSS, không phải 1 "dòng" thực sự có thể click/neo). Cần fallback rõ ràng cho trường hợp này.
- **Xung đột với gutter số dòng:** ảnh minh hoạ cho thấy editor đang bật `showLineNumbers` (thấy số `18`, `20` ở lề trái). Nếu neo icon ở "đầu dòng", icon dễ đè lên vùng gutter số dòng — 1 rủi ro hiển thị cụ thể của chính project này, cần né cột gutter khi tính toạ độ neo bên trái.
- **Tính nhất quán khi đổi quy tắc theo ngữ cảnh:** vì icon lúc thì bám sát cuối dòng, lúc thì nhảy ra dòng trống xa hơn tuỳ cấu trúc văn bản xung quanh, vị trí xuất hiện sẽ không nhất quán giữa các lần dùng → khó tạo thói quen "nhìn đâu để thấy icon" cho user qua thời gian, có thể ảnh hưởng khả năng phát hiện (discoverability) về lâu dài so với 1 quy tắc neo cố định duy nhất.

**3 phương án vị trí khác đề xuất thêm (ngoài "đầu/cuối dòng hoặc dòng trống gần nhất" của user):**

- **(E) Neo vào lề bên (margin anchor).** Nếu layout content có max-width và để trống khoảng lề 2 bên (khi cửa sổ rộng), đặt icon cố định tại 1 cột lề bên phải (giống Google Docs/Word đặt icon comment ở lề phải bài viết), chỉ đổi toạ độ dọc (`top`) theo vị trí dòng chứa selection, `left` luôn cố định trong vùng lề. Ưu điểm: hoàn toàn tách khỏi luồng chữ, không bao giờ đè/tràn vào text hay gutter số dòng, không cần phân biệt "cuối dòng" hay "dòng trống" — luôn 1 quy tắc duy nhất, dễ đoán vị trí. Nhược điểm: khi cửa sổ hẹp (không đủ lề trống), cần phương án dự phòng (vd thu nhỏ icon, hoặc rơi về 1 trong các phương án khác).
- **(F) Bubble nổi phía trên vùng chọn (giống Notion "Ask AI"/Google Docs comment bubble), căn giữa theo chiều ngang của chính đoạn text được chọn.** Luôn lấy điểm giữa (`(rect.left + rect.right) / 2`) của bounding box vùng chọn, đặt icon ngay phía trên, cách 1 khoảng nhỏ để không đè lên chữ. Nếu không đủ chỗ phía trên (selection ở sát mép trên viewport) thì lật xuống dưới — cùng cơ chế flip mà các thư viện tooltip hay dùng. Ưu điểm: 1 quy tắc duy nhất, không phụ thuộc việc dòng có bị wrap hay đoạn văn có dòng trống liền kề hay không — luôn có 1 điểm neo xác định dựa thẳng vào chính vùng chọn.
- **(G) Neo vào mép cuối của cả khối block chứa selection (end-of-block), không phải cuối dòng-hiển-thị hay dòng trống.** Lấy `getBoundingClientRect()` của phần tử block-level gần nhất chứa selection (`<p>`/`<li>`/`<h#>`...) thay vì của Range dòng-hiển-thị, đặt icon ngay sau mép phải/dưới của khối đó. Vẫn giữ tinh thần "gần đoạn văn chứa selection" như đề xuất gốc của user, nhưng có 1 mốc toạ độ xác định duy nhất (bounding box của phần tử DOM, luôn tồn tại) thay vì phải tìm "dòng trống gần nhất" (có thể không tồn tại tuỳ cấu trúc HTML xung quanh).

**Khuyến nghị (ưu tiên tính thuận tiện cho user): chọn (F), không chọn (E)/(G)/đề xuất gốc.**

Lý do so sánh trực tiếp trên tiêu chí thuận tiện — phát hiện nhanh (discoverability), tốn ít thao tác di chuột (Fitts's Law: đích gần thì thao tác nhanh hơn), nhất quán qua mọi ngữ cảnh:

- **(F) thắng vì luôn có đúng 1 mốc toạ độ xác định:** `Range.getBoundingClientRect()` của chính vùng chọn **luôn tồn tại**, bất kể đang ở dòng đơn, dòng bị wrap, trong list, table, blockquote, đầu/cuối tài liệu — không phụ thuộc "có dòng trống liền kề không" (rủi ro của đề xuất gốc) hay "có đủ lề trống không" (rủi ro của (E)).
- **(F) tốn ít thao tác di chuột nhất:** icon xuất hiện gần như ngay tại nơi mắt/chuột user đang ở (vừa mới select xong) — (E) neo lề bên có thể buộc user rê chuột ngang qua cả màn hình nếu selection nằm bên trái 1 cửa sổ rộng, ngược hẳn tinh thần "quick action ngay tại chỗ".
- **(F) không đụng gutter số dòng:** vì neo theo bounding box của chính vùng chọn (luôn nằm trong vùng nội dung, không bao giờ lấn sang cột gutter bên trái) — rủi ro gutter chỉ phát sinh với cách neo "đầu dòng" của đề xuất gốc, (F) tránh được hoàn toàn mà không cần logic né gutter riêng.
- **(F) nhất quán 100%:** luôn là "phía trên vùng chọn, canh giữa" — không có nhánh rẽ tuỳ ngữ cảnh (khác với đề xuất gốc phải chọn giữa "cuối dòng" hay "dòng trống" tuỳ cấu trúc văn bản xung quanh) → dễ tạo thói quen nhìn đúng chỗ qua thời gian sử dụng.
- **Kết hợp thêm quyết định toạ độ đã brainstorm ở trên (đổi `position: fixed` → `position: absolute` theo toạ độ tài liệu):** áp dụng luôn cho (F) — bubble neo theo `rect.top + window.scrollY`, cuộn tự nhiên cùng nội dung, giải quyết đồng thời cả yêu cầu "không floating theo scroll" đã nêu ở phần 2 (ảnh minh hoạ) mà không cần thêm cơ chế riêng.

**Phương án fallback đề xuất cho (F) — vẫn ưu tiên thuận tiện:**

1.  **Không đủ chỗ phía trên (selection ở sát mép trên viewport):** lật xuống dưới vùng chọn thay vì phía trên — cùng cơ chế flip chuẩn của tooltip/popover, đã có sẵn tinh thần clamp tương tự trong `positionNear()`/`positionPopover()` hiện tại (`Math.min`/`Math.max` theo `window.innerWidth/innerHeight`).
2.  **Selection trải dài nhiều dòng hiển thị:** neo theo dòng **cuối cùng** của vùng chọn (`sel.getRangeAt(...)` lấy dòng chứa điểm `focus`), không phải dòng đầu — vì thao tác kéo chọn thường kết thúc ở đó, chuột user *đang* ở gần vị trí đó nhất lúc buông tay → icon xuất hiện đúng ngay dưới/trên con trỏ hiện tại, không bắt user nhìn ngược lên đầu vùng chọn.
3.  **Sát mép trái/phải viewport (cửa sổ hẹp, hoặc selection ở đầu/cuối dòng dài):** clamp toạ độ ngang trong khoảng `[4, window.innerWidth - iconSize - 4]` — tái dùng đúng pattern `positionNear()` đang có sẵn (cross-file-search.ts:145-151), không cần logic mới.
4.  **Trong table cell / vùng có `overflow` hẹp:** không phát sinh vấn đề vì icon vẫn append trực tiếp vào `document.body` (như code hiện tại đã làm), không bị kẹp bởi `overflow` của cell — bubble có thể "tràn" ra ngoài ranh giới cell một cách hợp lệ, không bị cắt hình.

**Đã chốt:** user xác nhận chọn (F) + 4 fallback trên. Gutter số dòng không cần xử lý riêng vì (F) neo theo bounding box của chính vùng chọn (luôn nằm trong vùng nội dung, không lấn sang gutter) — không phát sinh rủi ro đã nêu ở đề xuất gốc.

**C3 coi như đã chốt toàn bộ:** debounce 750ms + listener `copy`/`cut`/Backspace-Delete, và vị trí icon (F) bubble phía trên vùng chọn neo theo tài liệu + 4 fallback.

**Đã implement (2026-07-12):** `CROSS_FILE_ICON_DEBOUNCE_MS` 250→750; listener `copy`/`cut` trên `#content` + `keydown` Backspace/Delete (gộp vào handler keydown chung sẵn có) đều huỷ debounce timer + ẩn icon. Icon đổi sang `position: absolute`, neo bubble phía trên vùng chọn (dòng cuối cùng qua `getClientRects()`), flip xuống dưới khi sát mép trên, clamp ngang. Bỏ hẳn `SCROLL_HIDE_THRESHOLD_PX`/listener `scroll`. Đã verify `tsc`/`eslint`/`test:unit` pass. Chưa test tay F5.

---

### C4. Search option, mặc định "match full word"

**Bug.md:** *"thêm các search option với mặc định là search match full word."*

**Hiện trạng:** Cả 3 tính năng (Ctrl+F, Feature A, Feature B) dùng chung `findMatches()`/`collectHaystack()` trong `match-utils.ts`, hiện chỉ match kiểu substring, case-insensitive. Không có khái niệm "whole word" ở đâu trong code.

**Brainstorm:** Thêm option "Whole Word" (giống VS Code Ctrl+F: Match Case / Whole Word / Regex), lưu state ở nơi phù hợp (per-feature hay global?), thêm UI toggle.

**Phản biện / rủi ro — đây là mục mơ hồ và rủi ro nhất:**
- **Phạm vi áp dụng chưa rõ:** "search" ở đây là Ctrl+F, popover Feature B, hay cả Feature A? Vì cả 3 dùng chung lõi `match-utils.ts`, đổi default ở lõi sẽ đổi hành vi **cả 3 cùng lúc**, kể cả Feature A vốn thiết kế để "tự động tra cứu nhanh" mà không nên bị giới hạn full-word.
- **Word-boundary tiếng Việt là rủi ro kỹ thuật thật:** JS regex `\b` dựa trên `\w` = chỉ `[A-Za-z0-9_]`, **không nhận diện đúng ký tự có dấu tiếng Việt** (ă, â, ê, ô, ơ, ư, đ, các dấu thanh). Dùng `\b` kiểu naive sẽ tính sai ranh giới từ với chữ có dấu — mà toàn bộ nội dung dự án (test/bug.md, requirement...) đang là tiếng Việt. Bắt buộc phải tự viết word-boundary Unicode-aware (kiểm tra `\p{L}` ở 2 đầu match), không dùng `\b` mặc định.
- **Đổi default = thu hẹp UX cốt lõi:** Toàn bộ giá trị của Feature A/B là "select đoạn text bất kỳ → tự tìm chỗ khác chứa nó" (substring). Mặc định full-word sẽ khiến select "Editor" không còn match trong "MarkdownEditor"/"EditorProvider" — nhiều trường hợp thực tế sẽ ra "0 kết quả" gây cảm giác tính năng bị hỏng. Nên cân nhắc: giữ substring làm default, full-word chỉ là option **bật thêm**, không phải mặc định.
- **"Các option" (số nhiều) mơ hồ:** có phải muốn cả bộ Match Case / Whole Word / Regex kiểu VS Code, hay chỉ 1 toggle whole-word? Nếu là bộ đầy đủ, scope lớn hơn nhiều so với 1 dòng trong bug.md, nên tách thành requirement riêng.
- **UI đặt ở đâu?** Popover Feature B đã có header khá chật (count + dropdown scope). Ctrl+F (search.ts) hiện chỉ có input + count + prev/next + close, chưa có chỗ cho option row.

**Câu hỏi cần chốt:**
1.  Option áp dụng cho tính năng nào: chỉ Feature B (popover xuyên file), hay cả Ctrl+F và Feature A?
2.  Danh sách option cụ thể: chỉ "Whole Word", hay cả "Match Case"/"Regex"?
3.  Mặc định thật sự muốn là "whole word" (thu hẹp kết quả, có rủi ro 0-result với compound word), hay ý muốn nói "mặc định của *option mới thêm* là bật whole-word" trong khi hành vi gốc (substring) vẫn giữ nguyên khi tắt option?
4.  Có chấp nhận việc word-boundary cho tiếng Việt cần code riêng (không dùng `\b` chuẩn) không — ảnh hưởng độ phức tạp/thời gian làm?

**Đã chốt (trả lời của user):**

1.  **Phạm vi áp dụng: Ctrl+F (`search.ts`) và Feature B (popover cross-file, `cross-file-search.ts`).** Feature A (`select-highlight.ts`, auto-highlight khi select) **không** có option row, giữ nguyên hành vi substring tự động như hiện tại — đúng lo ngại đã nêu ở phần phản biện (full-word mặc định sẽ thu hẹp UX "tự động tra cứu nhanh" của Feature A).
2.  **Danh sách option: dừng ở "Match Case" + "Whole Word".** Không thêm "Regex" ở bản này, nhưng **thiết kế code phải ready để mở rộng** — options nên là 1 cấu trúc dữ liệu (mảng/registry có `key`, `icon`, `tooltip`) thay vì 2 boolean rời rạc hard-code, để sau này thêm "Regex" chỉ là thêm 1 entry vào registry + 1 nhánh xử lý trong hàm match, không phải sửa lại UI/state đã có.
3.  **Mặc định thật sự là Whole Word = ON** (không phải chỉ "default của option mới trong khi giữ substring khi tắt" — user xác nhận muốn hành vi match full-word chạy ngay từ đầu). Match Case mặc định vẫn OFF (giữ case-insensitive như hiện tại).
    -   **Fallback bắt buộc đi kèm:** nếu Whole Word đang bật mà **không có kết quả nào**, tự động chạy lại theo substring (tắt tạm Whole Word cho lần tìm đó), **hiển thị thông báo** cho user biết đang xem kết quả substring (vd "Không có kết quả khớp nguyên từ — đang hiển thị kết quả theo chuỗi con"), và **đồng bộ lại trạng thái toggle Whole Word trên UI về OFF** để không gây hiểu lầm (toggle vẫn hiện ON trong khi kết quả thực tế là substring).
    -   Đây là safeguard trực tiếp cho rủi ro đã nêu ở phản biện gốc ("select 'Editor' không match 'MarkdownEditor'/'EditorProvider' → 0 kết quả gây cảm giác tính năng hỏng") — thay vì bỏ default full-word, xử lý bằng fallback + thông báo minh bạch.
4.  **Chấp nhận effort word-boundary Unicode-aware cho tiếng Việt.** Không dùng `\b`/`\w` chuẩn (chỉ nhận `[A-Za-z0-9_]`). Cách làm: dùng Unicode property escape (`\p{L}`, `\p{N}`) với regex flag `u`, kiểm tra ký tự liền trước/sau match **không phải** chữ cái/số/`_` — ví dụ dạng `(?<![\p{L}\p{N}_])<query>(?![\p{L}\p{N}_])` — để biên từ đúng với ký tự có dấu (ă, â, ê, ô, ơ, ư, đ, các dấu thanh) thay vì bị `\b` chuẩn tính sai.

**UI:** tham khảo đúng cách trình bày Search của VS Code (theo ảnh đính kèm) — nhóm icon toggle nhỏ `Aa` (Match Case) / `ab` (Whole Word) nằm bên phải, trong input search (không phải hàng riêng bên dưới), trạng thái active có viền/nền nổi bật khi bật. Áp dụng cho cả input Ctrl+F (`#search-box`) và input trong popover Feature B. Cấu trúc UI cũng nên render từ cùng registry option ở điểm 2 (lặp qua danh sách option để tạo nút toggle), để thêm nút `.*` (Regex) sau này chỉ là thêm 1 phần tử vào registry, không phải viết lại markup.

**Đã implement (2026-07-12):** lõi so khớp Unicode-aware thuần `findTextMatches()` (`src/shared/text-match.ts`, dùng chung webview + host Node); registry `MATCH_OPTION_DEFS` + `buildMatchOptionToggles()` (`media/webview/match-options.ts`, dùng chung `search.ts`/`cross-file-search.ts`); mặc định Whole Word ON/Match Case OFF; fallback substring khi 0 kết quả (cục bộ ở Ctrl+F, cùng round-trip ở host cho Feature B) kèm đồng bộ toggle về OFF + thông báo. Thêm 14 unit test cho `findTextMatches` (gồm case tiếng Việt "trường"/"đường" chứng minh không dùng `\b` chuẩn). Đã verify `tsc`/`eslint`/`test:unit` (62/62)/`esbuild --production` đều pass. Chưa test tay F5.

---

### C5. Highlight từ khóa trong kết quả tìm kiếm

**Bug.md:** *"kết quả tìm kiếm phải hightlight được từ đang tìm trong phần show kết quả."*

**Hiện trạng: đã implement phần tô màu, nhưng có bug hiển thị khi dòng dài / popover hẹp.** `cross-file-search.ts:218-246` (`renderMatchRow`) đã bọc phần match trong `<span class="cross-file-search-mark">`; `editor.css:896-899` đã style `background: rgba(255, 197, 61, 0.35)` — phần tô màu tự nó đúng, **không phải bug contrast**.

**Repro xác nhận (từ ảnh chụp màn hình user cung cấp):** popover hẹp (`width: 320px` cố định — `editor.css:797`), 1 số dòng kết quả dài không thấy đoạn highlight đâu cả, dù nó vẫn tồn tại trong DOM.

**Root cause (đã trace trong code):**
- `provider.ts:675-682`: "context" quanh match không phải cửa sổ ký tự cố định, mà là **nguyên 1 dòng trước + nguyên 1 dòng sau** (`lines[lineNo - 1].trim()` / `lines[lineNo + 1].trim()`), không giới hạn độ dài.
- `cross-file-search.ts:224-246` (`renderMatchRow`) ghép chuỗi theo thứ tự: `contextBefore + " " + before + <mark>mid</mark> + after + " " + contextAfter` — tất cả nối liền thành 1 dòng text duy nhất trong `<button class="cross-file-search-match">`.
- `editor.css:872-887` (`.cross-file-search-match`): `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` — không wrap, không scroll ngang, cắt bằng ellipsis **chỉ ở mép phải**.
- **Hệ quả:** nếu `contextBefore` (nguyên dòng trước) + đoạn text trước match đã dài hơn bề rộng 320px, toàn bộ phần `<mark>` và mọi thứ sau nó bị đẩy ra ngoài vùng nhìn thấy và bị `overflow: hidden` cắt mất hoàn toàn — không có dấu hiệu nào (`…`) báo cho user biết còn nội dung, và **highlight biến mất khỏi tầm nhìn dù vẫn tồn tại trong DOM**. Đây đúng là hiện tượng trong ảnh chụp màn hình.

**Đề xuất phương án giải quyết:**

- **(H) Cắt context theo ngân sách ký tự, canh giữa quanh match — khuyến nghị.** Thay vì nối nguyên dòng trước/sau không giới hạn rồi phó mặc cho CSS ellipsis, tự cắt chuỗi *trước khi* đưa vào DOM:
  - Xử lý riêng "phần trái" (`contextBefore + before`) và "phần phải" (`after + contextAfter`), mỗi bên giới hạn 1 số ký tự cố định (vd `SNIPPET_CONTEXT_CHARS = 40`/bên, đặt cạnh các constant khác trong `constants.ts`).
  - Phần trái dài hơn ngân sách → cắt từ **đầu bên trái**, giữ lại đoạn sát match, thêm tiền tố `…`. Phần phải dài hơn ngân sách → cắt từ **cuối bên phải**, thêm hậu tố `…`.
  - Phần `mid` (chính đoạn match) **không bao giờ bị cắt**.
  - Kết quả: match luôn nằm trong vùng nhìn thấy của row bất kể dòng gốc dài bao nhiêu hay popover rộng bao nhiêu, đồng thời `…` cho user biết rõ có context bị cắt bớt hai đầu (giống cách VS Code Search view / GitHub code search vẫn làm).
  - Giữ nguyên `white-space: nowrap; overflow: hidden; text-overflow: ellipsis;` trên CSS như 1 lớp an toàn bổ sung (phòng trường hợp bề rộng ký tự thực tế lệch so với ước tính), nhưng bug chính được sửa ở tầng dựng chuỗi, không phải chỉ dựa vào CSS.
- **(I) Đổi `white-space: nowrap` → `normal` để dòng tự wrap xuống dòng 2/3.** Đơn giản hơn (chỉ sửa CSS, không đổi logic dựng chuỗi), nhưng row sẽ có chiều cao thay đổi thất thường giữa các kết quả (dòng ngắn 1 hàng, dòng dài 3-4 hàng), phá vỡ layout list gọn hiện tại và khiến scroll trong popover khó ước lượng hơn.
- **(J) Tăng bề rộng popover.** Không giải quyết triệt để (luôn có dòng đủ dài để vẫn tràn), và đi ngược quyết định đã chốt ở C3 (bubble (F) gọn, đặt ngay sát vị trí select, không phải 1 panel rộng).

**Khuyến nghị: chọn (H).** Sửa đúng nguyên nhân (unbounded context nối chuỗi), giữ UX gọn của popover, và cho user tín hiệu rõ ràng (`…`) thay vì cắt lặng lẽ.

**Đã chốt (trả lời của user):** xác nhận là bug cần fix, đi theo phương án (H), đồng ý ngân sách 40 ký tự/bên.

**Đã implement:**
-   `constants.ts`: thêm `SNIPPET_CONTEXT_CHARS = 40`.
-   `cross-file-search.ts` (`renderMatchRow`): ghép `contextBefore + before` thành 1 chuỗi trái, `after + contextAfter` thành 1 chuỗi phải; cắt mỗi bên bằng `truncateContextLeft`/`truncateContextRight` (giữ đoạn sát match, thêm `…` khi bị cắt) *trước khi* đưa vào DOM, thay vì phó mặc cho CSS `text-overflow: ellipsis`. Phần `mid` (chính đoạn match, bọc `<span class="cross-file-search-mark">`) không bao giờ bị cắt.
-   Đã verify: `tsc --noEmit`, `eslint`, `esbuild --production`, `npm run test:unit` (48/48) đều pass.
-   Chưa test tay UI (cần mở Extension Development Host — F5) để xác nhận 40 ký tự/bên vừa mắt với popover 320px/font 12px thực tế; có thể chỉnh `SNIPPET_CONTEXT_CHARS` nếu thấy chật/rộng.

---

### C6. Link mở file phải scroll đến đúng chỗ — bug thật, ưu tiên cao

**Bug.md:** *"đường link cần mở ra file và scroll đến đúng chỗ."*

**Hiện trạng — phát hiện quan trọng nhất trong đợt rà soát này:**
- File **không phải .md**: `provider.ts` dùng `vscode.commands.executeCommand('vscode.open', uri, {selection: range})` → text editor chuẩn của VS Code, `selection` hoạt động đúng, tự scroll tới vị trí. **Không có bug.**
- File **.md**: dùng `vscode.commands.executeCommand('vscode.openWith', uri, viewType, {selection: range})` để mở bằng Orca Editor (custom webview editor). Nhưng `resolveCustomTextEditor()` (provider.ts:72-166) **hoàn toàn không đọc `selection`/vị trí ban đầu nào** — message `init` gửi sang webview chỉ có text + config, không có "scroll tới dòng X". Phía webview (`main.ts`) chỉ scroll trong 2 trường hợp: anchor heading (`scrollToAnchor`) và khôi phục `scrollTop` đã lưu từ session trước (`vscode.setState`). Không có đường dẫn nào forward `selection` từ `openWith` sang webview.
- **Nguyên nhân gốc:** `selection` trong `TextDocumentShowOptions` chỉ được VS Code tự áp dụng cho **text editor chuẩn**; với custom editor webview, không có khái niệm "cursor" nội tại — extension phải tự đọc & forward vị trí đó, mà code hiện tại chưa làm.
- **Hệ quả:** click 1 kết quả cross-file trỏ tới file `.md` → mở đúng file nhưng **không scroll tới đúng match**, chỉ về vị trí `scrollTop` cũ đã lưu hoặc đầu file. Đây khớp chính xác với report ở bug.md.

**Brainstorm hướng sửa (không phải phần cần chốt về scope, nhưng nên note vì đây là bug xác nhận được, không phải feature mới cần brainstorm UX):**
- `openWith` không nhận tham số custom nào ngoài `ViewColumn`/`TextDocumentShowOptions` (mà phần `selection` bị bỏ qua với custom editor) → cần một kênh khác để truyền `line`/`character`, ví dụ: provider giữ một map tạm "pending reveal theo uri" khi nhận `crossFileSearch:openResult`, rồi đọc lại ở bước xử lý message `ready`/gửi `init` để kèm lệnh scroll cho đúng document đang mở; hoặc encode vị trí vào query string của uri và đọc lại trong `resolveCustomTextEditor`.
- Cần xử lý trường hợp file `.md` đó **đã đang mở sẵn** trong 1 tab Orca Editor khác — lúc này `resolveCustomTextEditor` không chạy lại, phải gửi message `scrollToPosition` trực tiếp tới webview panel đang tồn tại thay vì qua đường `init`.

**Câu hỏi cần chốt:**
1.  Xác nhận đây là bug cần fix (không phải feature mới), ưu tiên fix trước các item brainstorm khác ở trên?
2.  Case "file .md đã mở sẵn ở tab khác" — có cần xử lý (scroll tới vị trí mới) hay chỉ cần focus tab đó là đủ?

**Đã chốt (trả lời của user):**
2.  **Vẫn phải scroll tới đúng vị trí match, kể cả khi file `.md` đó đã mở sẵn ở 1 tab Orca Editor khác** — không được coi "focus lại tab cũ" là đủ. Đúng theo hướng đã note ở brainstorm: trường hợp `resolveCustomTextEditor` không chạy lại (webview panel đã tồn tại), phải gửi message `scrollToPosition` trực tiếp tới panel đang mở đó, thay vì chỉ qua đường `init`.

**Đã implement (2026-07-12):** cả 2 case (panel mới mở lẫn đã mở sẵn). `messages.ts` thêm `reveal?` vào message `init` + biến thể `scrollToPosition` mới. `provider.ts`: registry `panelsByUri` (Map<uri, Set<panel>>, có tính tới `supportsMultipleEditorsPerDocument`), `pendingReveal` dùng 1 lần cho panel mới; panel đã mở thì `reveal()` + `postMessage('scrollToPosition')` trực tiếp, không gọi lại `openWith`. `gutter.ts` thêm `scrollToSourceLine()` tái dùng cơ chế ánh xạ data-line/data-line-end sẵn có. `main.ts` xử lý cả `init.reveal` và `scrollToPosition`. Đã verify `tsc`/`eslint`/`test:unit` pass. Chưa test tay F5.

---

### C7. Viewport band trên thước overview — hiển thị đang cuộn tới đâu

**Nguồn:** user quan sát thước overview (mép phải, `#search-overview`/`#select-overview`, xem C1) chỉ đánh dấu vị trí match/selection, không có chỉ báo nào cho biết khung nhìn hiện tại đang ở đâu trong tài liệu khi cuộn.

**Đã chốt (trả lời của user):** gắn viewport band vào thước overview sẵn có — chỉ hiện khi `#search-overview`/`#select-overview` đang hiện (Ctrl+F mở hoặc có select-highlight match), không làm 1 thước scroll-position độc lập luôn hiện (scope lớn hơn, ngoài phạm vi lần này).

**Đã implement (2026-07-12):** `createViewportBand()`/`updateViewportBand()` dùng chung trong `match-utils.ts` — phần tử riêng (`#search-viewport-band`/`#select-viewport-band`, không phải tick con) vì `buildOverviewTicks()` xoá sạch container mỗi lần rebuild. `top`/`height` (%) tính từ `scrollY`/`innerHeight` so với chiều cao tài liệu, cập nhật qua listener `scroll` riêng (coalesce bằng `requestAnimationFrame`, độc lập với throttle rebuild tick của Feature A). Ẩn/hiện đồng bộ tay với container overview tương ứng ở mọi nhánh đổi `hidden` (paint/close ở `search.ts`; buildStripThrottled/clearStrip ở `select-highlight.ts`). Màu trung tính xám mờ để không nhầm với tick match (vàng/cam). Đã verify `tsc`/`eslint`/`test:unit` (62/62)/`esbuild --production` đều pass. Chưa test tay F5.

---

## Tóm tắt câu hỏi cần user trả lời (gộp lại)

| # | Câu hỏi |
|---|---|
| C1 | ~~Đã chốt & implement (2026-07-12)~~ — không click-to-jump; tắt hẳn Feature A (paint + strip) khi Ctrl+F mở; safeguard chọn hướng (D) throttle ~150ms, cap 500 node/lần làm an toàn thêm ở tầng implementation. |
| C2 | ~~Đã chốt & implement (2026-07-12)~~ — 3s từ lúc icon hiện, pause khi hover/focus, reset về đủ 3s khi rời hover (không resume phần dở); phím tắt độc lập, không tham gia cơ chế này. |
| C3 | ~~Đã chốt & implement (2026-07-12)~~ — debounce 750ms + listener copy/cut/Backspace-Delete; vị trí icon = (F) bubble phía trên vùng chọn, neo theo tài liệu (absolute) + 4 fallback. |
| C4 | ~~Đã chốt & implement (2026-07-12)~~ — áp dụng cho Ctrl+F + Feature B (không áp dụng Feature A); chỉ Match Case + Whole Word, thiết kế registry ready cho Regex sau này; mặc định Whole Word = ON, Match Case = OFF, có fallback substring + thông báo + đồng bộ lại toggle khi 0 kết quả; word-boundary Unicode-aware cho tiếng Việt; UI kiểu Aa/ab của VS Code. |
| C5 | ~~Đã chốt & implement~~ — bug xác nhận (popover hẹp, dòng dài → highlight bị `overflow:hidden` cắt mất); đã sửa theo (H): cắt context 40 ký tự/bên quanh match trước khi đưa vào DOM. |
| C6 | ~~Đã chốt & implement (2026-07-12)~~ — cả case panel mới mở lẫn đã mở sẵn ở tab khác đều scroll tới đúng vị trí match (`init.reveal` / `scrollToPosition`), không chỉ focus tab. |
| C7 | ~~Đã chốt & implement (2026-07-12)~~ — viewport band gắn vào thước overview sẵn có (không làm thước độc lập), cập nhật live theo scroll, ẩn/hiện đồng bộ với `#search-overview`/`#select-overview`. |

**Còn lại (chưa làm trong đợt này):** kiểm thử thủ công F5 (Extension Development Host) cho toàn bộ C1–C4, C6, C7 — xem checklist ở cuối từng mục "Đã implement" phía trên; `tsc`/`eslint`/`test:unit` (62/62)/`esbuild --production` đã pass nhưng chưa thay thế được test tương tác UI thực tế.
