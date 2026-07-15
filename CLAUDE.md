# CLAUDE.md

## Quy tắc bắt buộc: Update History

Mỗi khi sửa một lỗi (bug fix) hoặc thêm một tính năng (feature), phải ghi lại một dòng ngắn gọn (tối đa 30 từ) vào file \[Update History.md\](Update History.md) ở thư mục gốc repo code này (`Markdown Preview VS Code/`).

Cấu trúc bảng:  `Date | Update Content`

-   **Date**: ngày thực hiện thay đổi, định dạng `YYYY-MM-DD`.
-   **Update Content**: mô tả ngắn gọn, tối đa 30 từ, nêu rõ đây là fix hay feature.

Thêm dòng mới vào cuối bảng, không sửa các dòng cũ.

## Quy tắc bắt buộc: Cấu trúc Requirement (HLR = master list)

Requirement được quản lý trong **repo riêng** `../OrcaEditor-Requirements/` (sibling folder, thêm vào cùng VS Code workspace với repo code này — xem `OrcaEditor.code-workspace`). `../OrcaEditor-Requirements/High-Level Requirement.md` (HLR) là **master list**, liệt kê mục lục tính năng đánh số tuần tự (hiện tại 1–18, tăng dần — không giới hạn ở 14). Mỗi mục lớn phải liên kết 2 chiều với 1 file requirement chi tiết:

-   File chi tiết đặt tên `../OrcaEditor-Requirements/Requirement - NN <Tên tiếng Anh>.md` (NN = số thứ tự 2 chữ số khớp số mục trong HLR — **không có ngoại lệ đặt tên không đánh số**, kể cả file design-log/brainstorm bổ trợ).
-   Đầu file chi tiết phải có dòng **Sources:** trỏ về `[High-Level Requirement.md](High-Level%20Requirement.md)` kèm số mục tương ứng (vd. "section 7").
-   Trong HLR, ngay dưới heading `## N. <Tên>`, phải có dòng `📄 *Chi tiết: [Requirement - NN <Tên>.md](...)* — <Status>` trỏ tới file chi tiết đó, kèm tag Status.

**Status tag (bắt buộc ở cả HLR và đầu file chi tiết):**

-   `✅ Shipped` — đã code & verify (tsc/eslint/test hoặc tương đương).
-   `🚧 WIP` — đang code, hoặc đã code một phần (1 số sub-item Shipped, số khác chưa).
-   `📝 Planned` — đã chốt spec qua brainstorm nhưng **chưa code dòng nào**.

Nếu 1 mục có nhiều sub-item với status khác nhau (vd 1 phần đã ship, 1 phần còn WIP) → gắn status ở **từng bullet con** (15.1, 15.2...) thay vì chỉ 1 status chung chung cho cả mục, để không che mất phần còn thiếu.

Khi tạo requirement chi tiết **mới**:

1.  Nếu mục đó đã có trong HLR → tạo file `Requirement - NN <Tên>.md` theo format của các file mẫu hiện có (User Story + Acceptance Criteria, có **Date/Status/Scope/Sources**), rồi thêm dòng "📄 Chi tiết" + status vào đúng mục trong HLR.
2.  Nếu là tính năng hoàn toàn mới (chưa có mục trong HLR) → **luôn thêm 1 mục số mới** (số kế tiếp, vd 17, 18...) vào cuối mục lục HLR ngay khi tạo file chi tiết — **không** để ở khu vực riêng ngoài mục lục chờ code xong mới đánh số. Gắn status `📝 Planned` (chưa code) hoặc `🚧 WIP` (đang code) ngay từ đầu, rồi cập nhật lên `✅ Shipped` khi hoàn tất.
3.  File design-log/brainstorm bổ trợ cho 1 mục đã có sẵn (vd log chi tiết cho tính năng đã có bullet gọn trong 1 mục khác) cũng phải qua đúng flow trên: được cấp 1 số mục riêng trong HLR (không nhét vào ghi chú của mục khác), và mục gốc chỉ trỏ sang bằng 1 dòng tham chiếu ngắn.
4.  Không được để HLR lệch khỏi các file chi tiết — mỗi lần sửa nội dung 1 file chi tiết làm thay đổi phạm vi hoặc status của tính năng, phải rà lại bullet + status tương ứng trong HLR.

## Quy tắc bắt buộc: Test roundtrip cho tính năng đổi `.md`

Bất kỳ tính năng/thay đổi code nào làm thay đổi **nội dung raw `.md`** (toolbar format, input rules, table editing, chèn link/ảnh/math/mermaid, paste ảnh, list/task list, mọi thao tác đi qua turndown/serialize...) đều **bắt buộc phải có test roundtrip tự động chạy bằng Node** trong `test/roundtrip/`, không được coi là xong nếu chỉ test tay.

-   Test roundtrip nằm ở `test/roundtrip/<feature>.ts`, tách theo feature (rendering, table, lists, dom-normalize, toolbar, input-rules...) để chạy lại riêng từng cái: `npm run test:roundtrip:<feature>`. Chạy gộp tất cả: `npm run test:roundtrip` (tự dò mọi file trong `test/roundtrip/`, không cần khai báo tay từng cái).
-   Hạ tầng dùng chung (`serializeHtml`, `checkRoundtrip`, `Runner`...) nằm ở `test/roundtrip/_lib.ts` — file feature mới chỉ cần `import` từ đó, không copy lại logic.
-   Vì nhiều thao tác editor dùng `document.execCommand`/Selection API (chỉ có ở webview thật, không chạy được trong Node/domino), pattern chuẩn là **DOM-outcome test**: dựng HTML mô tả đúng DOM mà thao tác đó tạo ra (đọc source để biết chính xác cấu trúc, không đoán), feed vào `serializeHtml()`, so khớp markdown kỳ vọng, rồi kiểm tra ổn định khi render lại + serialize lần 2 (giống các case có sẵn trong `test/roundtrip/table.ts`/`lists.ts`).
-   Khi thêm/sửa 1 mục trong HLR làm thay đổi cách 1 tính năng ghi ra `.md`, phải rà lại test roundtrip tương ứng — thiếu test coi như chưa xong việc, kể cả khi tsc/eslint pass.

## Quy tắc bắt buộc: Ngôn ngữ output vs. hội thoại

Mọi **output của dự án** — code, comment, tên biến/hàm, chuỗi hiển thị trong UI (webview, toolbar, thông báo lỗi/empty-state...), commit message, tài liệu (`Update History.md`, requirement, docs khác) — **luôn viết bằng tiếng Anh**, không có ngoại lệ.

Chỉ **câu trả lời của AI trong khung chat/conversation** với người dùng mới dùng tiếng Việt. Không dịch ngược code/tài liệu sang tiếng Việt vì lý do "cho dễ đọc".

## Quy tắc bắt buộc: Git workflow

Khi thực hiện bất kỳ thao tác git nào (branch, commit, merge, PR, release, hotfix, worktree...), phải đọc và tuân theo [Plan/GIT_WORKFLOW.md](Plan/GIT_WORKFLOW.md) — file này định nghĩa cấu trúc branch, quy ước commit, vòng đời feature/release/hotfix, và cách trình bày (giải thích cho người mới + sitemap trạng thái sau mỗi commit).
