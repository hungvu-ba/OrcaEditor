## Bug List

2.  [x]  Các heading 1, 2, 3 khi bấm vào thì mất focus chỗ chuột đã dừng từ trước. Bấm lần 2 thì không remove heading về normal text.
3.  thêm tính năng để khi enter ở 1 dòng đang có format task thì dòng mới cũng sẽ có format task.
4.  nếu raw text đang ở dạng 1. \[ \] thì sẽ ko hiển thị 1. là bullet mà chỉ hiển thị task \[ \]
5.  khi search có scroll xuống matched text, nhưng khi bấm chuột thì lại bay về text cũ ở chỗ trước khi search. Cần cho phép bấm ở chỗ mới scroll đến, escape thì mới back lại chỗ chuột cũ.
6.  thêm tính năng report lỗi lên thẳng github. - later
7.  thêm tính năng paste hình ảnh từ clipboard vào editor. Có khả thi ko?

## Cross file search

-   khi select text thì ngoài hightlight các matched text thì còn cần highlight ở mép bên phải những dòng có matched text, giống tính năng khi dùng Cmd + F
-   Button search cần ẩn đi sau 3s nếu user không chọn.
-   Tăng delay time button xuất hiện lên 2s từ khi user select text.
-   thêm các seach option với mặc định là search match full word.
-   kết quả tìm kiếm phải hightlight được từ đang tìm trong phần show kết quả.
-   đường link cần mở ra file và scroll đến đúng chỗ.

## Bug Analysis

### Bug 2 — Heading H1/H2/H3: mất vị trí con trỏ, bấm lần 2 không revert về normal text ✅ Đã fix

**Root cause**: [dom-utils.ts:114-129](../media/webview/dom-utils.ts#L114-L129) (`replaceBlockTag`, gọi từ [toolbar.ts:505-529](../media/webview/toolbar.ts#L505-L529) `formatHeading`) build lại block bằng `execCommand('insertHTML', ..., '<h1>' + block.innerHTML + '</h1>')` — serialize nội dung cũ thành chuỗi HTML rồi tạo node hoàn toàn mới, không di chuyển node cũ (khác `toggleBlockquote` ở dòng 532-562 vốn giữ nguyên child node nên restore đúng caret). Comment tại dòng 110-112 tự thừa nhận không thể khôi phục đúng offset caret cũ vì node cũ đã bị gỡ khỏi DOM.

Hệ quả:

1.  `placeCaretIn(el)` (dòng 127) luôn `range.collapse(true)` → caret luôn nhảy về **đầu block mới**, mất vị trí cũ.
2.  Việc xác định `el` (block mới) dựa vào đoán qua `window.getSelection()` **sau** khi insertHTML chạy (dòng 124-126). Khi Chrome không đặt selection bên trong `<h1>` như kỳ vọng, code fallback về `content.lastElementChild` — block cuối cùng của **toàn bộ tài liệu**, không liên quan gì đến heading vừa tạo. Lần bấm thứ 2 do đó thao tác nhầm lên block sai thay vì heading gốc.

**Đề xuất fix**: giữ nguyên cách dùng `execCommand` (để không phá undo/redo), nhưng:

-   Xác định block mới bằng **vị trí DOM** (lưu `block.nextSibling` trước khi insertHTML, suy ra block mới = `nextSibling ? nextSibling.previousElementSibling : parent.lastElementChild`) thay vì đoán qua selection — luôn đúng vì vị trí chèn không đổi.
-   Khôi phục đúng offset caret: tính offset ký tự từ đầu block đến caret *trước khi* đổi tag (tái dùng logic kiểu `textBeforeCaret` ở [input-rules.ts:65-79](../media/webview/input-rules.ts#L65-L79)), sau đó duyệt text node của block mới để đặt caret đúng offset đó thay vì luôn collapse về đầu.

**Impact analysis nếu sửa**:

-   *Nơi gọi `replaceBlockTag` — được hưởng lợi trực tiếp, không cần đổi API*: `formatHeading` (nút H1/H2/H3/¶ trong toolbar) và `applySpaceInputRule` ở [input-rules.ts:226-232](../media/webview/input-rules.ts#L226-L232) (gõ `#` tự chuyển heading).
-   *Không được đụng vào*: `placeCaretIn` dùng chung — đang được gọi ở nhiều nơi khác (table.ts khi tạo ô/hàng mới, `insertListItemViaExec` khi tạo `<li>` mới, hr/code-fence trong `applyEnterInputRule`) và ở TẤT CẢ các nơi đó hành vi "collapse về đầu/nội dung rỗng" là ĐÚNG ý muốn (ô bảng mới, list item mới, code block mới đều nên đặt caret ở đầu). Vì vậy fix phải khoanh vùng trong `replaceBlockTag` (logic riêng), tuyệt đối không sửa `placeCaretIn` dùng chung — nếu sửa nhầm sẽ làm hỏng hàng loạt tính năng bảng/list/code fence.
-   *Không ảnh hưởng*: `toggleBlockquote` (dòng 532-562) dùng cơ chế restore riêng, không gọi `replaceBlockTag`.
-   *Cần test kỹ sau khi sửa*: toggle heading khi block chứa formatting lồng (bold/italic/link — nhiều text node con, offset ký tự phải tính xuyên qua các node đó); toggle heading ở block đầu/cuối tài liệu; Ctrl/Cmd+Z ngay sau khi đổi heading vẫn phải hoàn tác đúng 1 bước (không phá lịch sử undo/redo — lý do ban đầu dùng execCommand thay vì thao tác DOM trần).

**Đã implement — và phát hiện thêm 1 root cause quan trọng hơn lúc thực nghiệm**: khi thực sự chạy thử trong Chromium thật (Playwright, bundle production), việc chỉ sửa cách xác định `el` (theo `previousElementSibling`/`nextElementSibling` thay vì đoán qua selection) là ĐỦ để fix vụ "mất focus" — nhưng vụ "bấm lần 2 không revert" hoá ra do một bug execCommand khác nghiêm trọng hơn phân tích ban đầu: khi block NGUỒN đang là heading, `execCommand('insertHTML', ..., '<p>...</p>')` **bỏ qua hoàn toàn HTML được chèn**, giữ nguyên tag heading cũ và merge luôn nội dung của block liền sau vào trong nó (kiểm chứng bằng probe độc lập, không qua code của extension — xem `<p>one</p><h1>two</h1><p>three</p>` chọn nguyên `<h1>` rồi insertHTML `<p>two</p>` → ra `<p>one</p><h1>twothree</h1>`, tag P bị Chrome lờ đi hoàn toàn). Tương tự khi đích là heading khác cấp, style heading cũ "rò rỉ" sang block liền sau.

Giải pháp: dùng `execCommand('formatBlock', false, tag)` thay cho `insertHTML` riêng cho trường hợp **block nguồn là heading** (áp dụng cho cả heading→p lẫn heading→heading khác) — không dính 2 bug trên, và tự động giữ đúng caret/vùng chọn kể cả khi có formatting lồng (bold/italic), nên không cần logic khôi phục offset thủ công cho nhánh này (chỉ mất thuộc tính `align`, set lại thủ công sau). Nhánh còn lại (block nguồn là `<p>`, vd tạo heading mới) vẫn giữ `insertHTML` như cũ kèm khôi phục offset ký tự — đã kiểm chứng hoạt động đúng, và tránh bug lồng heading lịch sử của `formatBlock` khi bấm lặp lại lúc TẠO heading (khác với bug mới phát hiện, xảy ra lúc BỎ heading).

Đã verify bằng Playwright trong Chromium thật, đúng bundle production: P→H1 giữ đúng offset caret xuyên qua bold, H1→P (bấm lần 2) revert đúng đúng vị trí, H1→H2 không rò rỉ style sang block liền sau, giữ đúng `align`, heading vẫn bị chặn trong ô bảng như cũ, và Ctrl/Cmd+Z hoàn tác đúng 1 bước cho cả hai chiều (không vỡ lịch sử undo/redo).

### Bug 3 — Enter ở dòng có format task, dòng mới không giữ format task ✅ Đã fix

**Root cause**: Không có đoạn code nào intercept Enter khi caret nằm trong `<li class="task-list-item">`. `applyEnterInputRule` ở [input-rules.ts:432-467](../media/webview/input-rules.ts#L432-L467) chỉ xử lý cho `<p>` (hr, code fence) vì `inputRuleParagraph()` (dòng 47-62) chỉ nhận block là `P`, loại `<li>` ra. Enter trong task item vì vậy rơi về hành vi split `<li>` mặc định của trình duyệt.

Checkbox được `addCheckbox()` ([dom-utils.ts:35-42](../media/webview/dom-utils.ts#L35-L42)) chèn như một `<input>` là **sibling đứng trước text**, không phải wrapper bao quanh nội dung. Khi trình duyệt split `<li>` lúc Enter, nó chỉ nhân bản định dạng *bao quanh* caret (b/i/span...); checkbox nằm trước caret nên ở lại `<li>` cũ, `<li>` mới sinh ra không có checkbox.

**Đề xuất fix**: thêm nhánh Enter riêng cho `li.task-list-item` (cùng chỗ với `applyEnterInputRule`, dùng execCommand('insertHTML') giống pattern `insertListItemViaExec` để giữ đúng undo/redo):

-   `<li>` hiện tại rỗng (không tính checkbox) → không preventDefault, để hành vi mặc định của trình duyệt tự outdent.
-   Có nội dung → preventDefault, tách phần text sau caret thành `<li>` mới chèn ngay sau, gọi `addCheckbox(newLi)` để gắn checkbox chưa check + class `task-list-item`, rồi đặt caret vào đó.

**Impact analysis nếu sửa**:

-   *Thứ tự trong keydown handler*: nhánh mới nằm trong cùng khối `e.key === 'Enter'` ở [input-rules.ts:34-38](../media/webview/input-rules.ts#L34-L38), cạnh `applyEnterInputRule` hiện có — về logic không giao nhau (heading/hr/fence chỉ áp dụng `<p>`, task chỉ áp dụng `<li>`) nhưng cần gọi đúng thứ tự return sớm để không xung đột.
-   *`fixOrphanNestedListItems`* (main.ts dòng 327+, chạy sau MỌI input event) xử lý trường hợp list con bị tách nhầm thành `<li>` rỗng đứng sau — vì `<li>` mới của fix này là sibling cùng cấp (không lồng), về lý thuyết không kích hoạt logic đó, nhưng cần test kèm task item có sub-list lồng bên trong để chắc chắn không có tương tác lạ.
-   *`gutter.ts` renumber* (dòng 138-144) đã tự re-scan toàn bộ khi DOM đổi (input event → `scheduleSync`/`refreshFromDom`) nên `<li>` mới không cần code renumber riêng — không ảnh hưởng thêm.
-   *`turndown.ts` taskCheckbox rule* (dòng 277-296) yêu cầu input checkbox là con trực tiếp của `<li>` (hoặc `<p>` đầu của `<li>`) — nếu dùng đúng `addCheckbox()` có sẵn (không viết logic tạo checkbox riêng) sẽ tự động tương thích, không cần sửa turndown.
-   *Cảnh báo cần quyết định*: `<li class="task-list-item">` bên trong ô bảng (do `convertCellLineToListItem` ở [input-rules.ts:399-429](../media/webview/input-rules.ts#L399-L429) tạo ra) có cấu trúc giống hệt task item ở top-level. Nếu nhánh Enter mới chỉ check `closest('li.task-list-item')` mà không loại trừ ngữ cảnh bảng, nó sẽ tự động áp dụng cả trong ô bảng (giống cách `applyCellListInputRule` đã hỗ trợ task list trong ô bảng qua phím Space) — cần xác nhận đây là hành vi MONG MUỐN, hay cần chặn giống các rule khác (heading/quote/hr/code vốn bị cấm trong ô bảng, xem comment dòng 8-9).

**Đã implement**: thêm `applyTaskListEnterRule()` ở [input-rules.ts:470-511](../media/webview/input-rules.ts#L470-L511), gọi cùng nhánh `e.key === 'Enter'` với `applyEnterInputRule` ([input-rules.ts:36](../media/webview/input-rules.ts#L36)). Cố tình **cho phép áp dụng cả trong ô bảng** (không loại trừ ngữ cảnh `td`/`th`) theo yêu cầu — hàm chỉ dựa vào `closest('li')` + class `task-list-item`, dùng chung cho mọi ngữ cảnh. Đã verify bằng Playwright chạy đúng bundle production (esbuild) trong Chromium thật: Enter ở cuối `<li>` task top-level và `<li>` task lồng trong `<td>` đều tạo `<li>` mới có checkbox riêng, chèn đúng vị trí (giữ nguyên các item còn lại).

### Bug 4 — "1. \[ \]" hiển thị cả số thứ tự lẫn checkbox ✅ Đã fix (ẩn số thứ tự)

**Đây là hành vi có chủ đích, không phải bug ngẫu nhiên**: đã ghi rõ trong comment tại [markdown.css:258-263](../media/markdown.css#L258-L263) — *"`<ol>` phải GIỮ số thứ tự, checkbox canh khoảng cách bình thường ngay sau số thay vì kéo lùi như bullet ẩn"*. `markdown-it-task-lists` (`node_modules/markdown-it-task-lists/index.js:50-55`) không phân biệt `<ul>`/`<ol>` — chỉ chèn checkbox vào `<li>` bắt đầu bằng `[ ]`/`[x]`, không đổi tag list. CSS chỉ ẩn marker số cho `ul.contains-task-list` (dòng 264-266), còn `ol.contains-task-list` cố tình giữ số (dòng 277-279).

**Phản biện 2 chiều**:

-   *Ủng hộ giữ nguyên*: giữ được thông tin thứ tự — hữu ích cho checklist kiểu "Bước 1: \[ \], Bước 2: \[ \]"; đây là quyết định đã cân nhắc kỹ (có comment giải thích rõ), không phải sơ suất.
-   *Ủng hộ đề xuất đổi (ẩn số, chỉ hiện checkbox)*: nhất quán với các editor phổ biến (Notion, Typora, Obsidian) hiển thị mọi task item giống nhau bất kể cú pháp gốc; số + checkbox cùng lúc dễ đọc nhầm là 2 khái niệm khác nhau.

Lưu ý thêm: gõ trực tiếp "1. " rồi "\[ \] " trong editor hiện **không** tạo được ordered-task — vì sau khi "1. " chuyển sang `<li>` ([input-rules.ts:260-273](../media/webview/input-rules.ts#L260-L273)), input rule cho task chỉ áp dụng khi block còn là `<p>` (`inputRuleParagraph()` chặn `<li>`), nên gõ tiếp "\[ \] " chỉ ra text thô. Case "1. \[ \]" hiện chỉ xảy ra khi mở file .md có sẵn cú pháp đó từ đĩa.

**Đề xuất**: cần bạn chốt hướng trước khi sửa vì sẽ đảo ngược quyết định đã ghi chú. Nếu chốt ẩn số: chỉ cần thêm CSS `ol.contains-task-list > li.task-list-item { list-style-type: none }` tương tự rule của `ul`.

**Impact analysis nếu sửa**:

-   Chỉ là thay đổi CSS, không đụng logic parse/serialize/DOM script nào — an toàn về mặt runtime, không có nguy cơ vỡ chức năng khác.
-   *Ảnh hưởng UX*: đảo ngược quyết định hiển thị đã có — nếu đang có file .md thực tế dùng cú pháp "1. \[ \] ..." thì hiển thị sẽ đổi ngay khi deploy; nên rà lại các tài liệu đang dùng cú pháp này trước khi đổi.
-   *Không ảnh hưởng round-trip serialize*: `turndown.ts` không đọc CSS list-style, việc ẩn số chỉ là hiển thị — export lại vẫn đúng theo cấu trúc `<ol><li>` thực tế trong DOM.
-   *Không ảnh hưởng các thao tác khác dựa trên `<ol>`*: Tab thụt lề (`execCommand('indent')`, [main.ts:633](../media/webview/main.ts#L633)) và toggle bullet/numbered/task trong toolbar (khoảng dòng 683) hoạt động dựa trên tag/class, không dựa vào CSS `list-style` hiển thị.

**Đã implement**: gộp rule `ol.contains-task-list` vào chung với `ul.contains-task-list` trong [markdown.css:258-274](../media/markdown.css#L258-L274) — cả hai đều `list-style-type: none` và checkbox kéo lùi vào đúng vị trí marker cũ. Đã verify bằng Playwright: render "1. \[ \] foo" qua đúng pipeline `markdown-it-task-lists` sản xuất, `getComputedStyle(li).listStyleType === 'none'`, chỉ còn checkbox hiển thị, không còn "1.".
