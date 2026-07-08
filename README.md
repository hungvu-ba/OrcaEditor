# Markdown WYSIWYG Preview

Extension VS Code (dùng nội bộ, không cần Marketplace) cho phép **vừa preview markdown giống hệt VS Code Markdown Preview, vừa chỉnh sửa trực tiếp trên preview** (WYSIWYG). Mọi thay đổi được đồng bộ ngược về file `.md` theo thời gian thực.

## Tính năng

- **Render giống VS Code Markdown Preview**: dùng cùng engine markdown-it với cấu hình tương đương (`html: true`, `linkify`, `breaks` đọc từ setting `markdown.preview.*`), CSS mô phỏng theo `markdown.css` của VS Code, tự đổi theo theme sáng/tối.
- **Chỉnh sửa trực tiếp**: gõ thẳng vào preview; hỗ trợ phím tắt **⌘B** đậm, **⌘I** nghiêng, **⌘⇧X** gạch ngang, **⌘E** inline code, **Tab/⇧Tab** thụt lề danh sách.
- **Toolbar**: heading H1–H3 (bấm lại để trở về đoạn văn), danh sách chấm/số/task list, trích dẫn (bấm lại để bỏ), khối code, bảng, đường kẻ ngang, liên kết, ảnh, hoàn tác/làm lại.
- **Đầy đủ thẻ markdown** (CommonMark + GFM như VS Code Preview):
  - Heading 1–6 (ATX + Setext), đoạn văn, hard/soft break
  - **Đậm**, *nghiêng*, ~~gạch ngang~~, `inline code`
  - Danh sách lồng nhau (chấm/số), task list `- [ ]` / `- [x]` (click được checkbox)
  - Bảng GFM có căn lề cột (`:---`, `:--:`, `---:`), `<br>` và `\|` trong ô
  - Code block có ngôn ngữ + syntax highlight, code thụt lề 4 space
  - Blockquote lồng nhau, liên kết (inline/reference/autolink/bare URL), ảnh (kể cả đường dẫn tương đối)
  - Đường kẻ ngang, escape `\*`, HTML entity, inline/block HTML (`<kbd>`, `<details>`, `<div>`...), HTML comment
  - Công thức toán KaTeX `$...$` và `$$...$$` (giống VS Code Markdown Math)
  - YAML front matter (hiển thị gấp gọn, giữ nguyên khi lưu)
- **Thao tác bảng trực quan**: đặt caret vào bảng → toolbar nổi (icon) hiện phía trên bảng: **thêm dòng trên/dưới**, **thêm cột trái/phải**, **căn trái/giữa/phải cả cột** (ghi ra đúng cú pháp `:---:` / `---:` của GFM), **xóa dòng/cột** và **xóa cả bảng** (icon thùng rác). **Tab/⇧Tab** nhảy giữa các ô; **Tab ở ô cuối cùng tự tạo dòng mới**. Thêm cột tự đặt tên header "New Column" (được chọn sẵn để gõ đè ngay); nếu cột đầu là **số thứ tự** thì thêm dòng sẽ tự điền số kế tiếp và đánh lại số các dòng phía sau. Xóa dòng header sẽ đưa dòng dữ liệu đầu lên làm header (GFM luôn cần header); xóa cột cuối cùng sẽ xóa cả bảng. Toolbar bảng tự ẩn sau 3 giây (rê chuột lên toolbar sẽ giữ nó lại), click chuột vào bảng để hiện lại.
- **Chèn link kèm gợi ý file trong dự án**: select text rồi bấm 🔗 → popup tự tìm và liệt kê các file trong workspace có tên liên quan đến đoạn text đó (không phân biệt hoa thường/dấu tiếng Việt — "Đăng ký sự kiện" khớp `dang-ky-su-kien.md`). Gõ trong ô nhập để tìm lại theo từ khác; chọn gợi ý bằng click hoặc ↑↓ + Enter → chèn link đường dẫn tương đối tới file. Nhập URL có scheme (`https://`...) thì tắt gợi ý.
- **Task list click được**: tick checkbox trực tiếp trên preview → file cập nhật `[x]`.
- **⌘+Click** để mở liên kết (link ngoài mở bằng trình duyệt, link tương đối mở file trong VS Code, anchor `#` cuộn tới heading).
- **Nút clipboard-@ trên toolbar**: copy `@file` vào clipboard cho chat Claude Code — tự điều hướng tới tab chat đang mở (reveal nếu bị che, giữ nguyên hội thoại) và focus ô nhập, bạn chỉ cần dán **⌘V**. Muốn chèn tự động hoàn toàn (đổi lại sẽ thấy nháy nhẹ do phải mở tạm text editor) thì bật setting `markdownWysiwyg.claudeAutoInsert`.

## Cài đặt (local)

```bash
cd "Markdown Preview VS Code"
npm install
npm run compile
npm run package        # tạo file markdown-wysiwyg-preview-0.1.0.vsix
```

Sau đó trong VS Code: **Extensions → ⋯ → Install from VSIX...** và chọn file `.vsix` vừa tạo.
Hoặc chạy thử không cần cài: mở thư mục này trong VS Code và nhấn **F5** (Extension Development Host).

## Cách dùng

- Mở file `.md`, bấm nút **Mở WYSIWYG Preview sang bên cạnh** trên thanh tiêu đề editor (hoặc `⌘⇧⌥V`).
- Hoặc chuột phải file trong Explorer → **Mở WYSIWYG Preview**.
- Hoặc **Reopen Editor With... → Markdown WYSIWYG Preview** để mở thay editor hiện tại.
- Lưu bằng **⌘S** như bình thường (thay đổi trên preview làm document "dirty" như gõ trong text editor).

## Kiểm thử

```bash
npm run test:roundtrip   # round-trip test: markdown → HTML → markdown → HTML phải ổn định
```

## Lưu ý thiết kế

- Khi bạn **chỉnh sửa lần đầu**, toàn bộ file được serialize lại nên **style markdown được chuẩn hóa** (heading Setext → ATX, bullet `+`/`*` → `-`, nghiêng `_` → `*`...). Nội dung và cách hiển thị không đổi, chỉ khác cách viết nguồn.
- Công thức KaTeX và front matter là khối "atom": hiển thị đúng nhưng muốn sửa nội dung thì sửa trong text editor (mở song song hai chế độ vẫn đồng bộ hai chiều).
- Mermaid không thuộc VS Code Markdown Preview mặc định nên chưa hỗ trợ.
