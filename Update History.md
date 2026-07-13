# Update History

| Version | Date | Update Content |
| --- | --- | --- |
| 0.5.7 | 2026-07-09 | Baseline: bắt đầu ghi update history từ phiên bản hiện tại. |
| 0.5.8 | 2026-07-09 | Fix: nút chèn bảng tạo bảng lồng bảng khi caret đang ở trong ô bảng khác, gây vỡ Markdown thuần. |
| 0.5.9 | 2026-07-09 | Fix: copy bảng/list trong editor rồi paste bị mất định dạng do clipboard lấy text thô thay vì Markdown. |
| 0.5.10 | 2026-07-09 | Fix: khối Mermaid/code/bảng/công thức ở cuối tài liệu không thêm được dòng mới phía dưới — luôn đảm bảo có đoạn văn thoát ở cuối. |
| 0.5.11 | 2026-07-10 | Feature: gutter số dòng thật (theo file .md gốc) bên trái mỗi block; thêm "Mở WYSIWYG Preview" vào menu chuột phải editor. |
| 0.5.12 | 2026-07-10 | Fix: gutter số dòng cho block Mermaid/công thức KaTeX — hiển thị dòng bắt đầu ở mép trên và dòng kết thúc ở mép dưới thay vì một số duy nhất, vì trình bày (biểu đồ/công thức) không tỉ lệ với số dòng nguồn. |
| 0.5.13 | 2026-07-10 | Feature: thêm "Mở WYSIWYG Preview" vào menu chuột phải trên tab editor (editor/title/context) để mở file .md bằng extension. |
| 0.5.14 | 2026-07-10 | Feature: đổi tên extension thành "Orca MD Preview" và nhãn menu thành "Mở Orca Preview". |
| 0.5.15 | 2026-07-11 | Feature: type an toàn cho kênh postMessage host↔webview — thêm src/shared/messages.ts với union WebviewToHost/HostToWebview (C3). |
| 0.5.16 | 2026-07-11 | Refactor: tách god file pipeline.ts thành render/dom-postprocess/dom-serialize-prep/turndown/dom-portable, giữ pipeline.ts làm barrel re-export, hành vi không đổi (C1). |
| 0.5.17 | 2026-07-11 | Fix (security): siết CSP (bỏ img-src https:, thêm form-action/frame-src none), realpath chống symlink ở openLink, nonce dùng crypto, thu hẹp localResourceRoots, log lỗi (S1–S8, C8). |
| 0.5.18 | 2026-07-11 | Fix (perf): debounce update host, cache findFiles/mermaid, debounce ô tìm + tách read/write layout, gate parse gutter; bundle --production (main.js −56%) + KaTeX chỉ woff2 (P-01…P-09). |
| 0.5.19 | 2026-07-11 | Refactor: gộp escapeHtml + helper chèn list trùng lặp, gom hằng debounce vào constants.ts, bật noUnusedLocals/noUnusedParameters + ESLint (typescript-eslint, security) (C2, C4, C5, C9, C-new). |
| 0.5.20 | 2026-07-11 | Feature: thêm 48 unit test (computeMinimalEdit, normalizeForSearch, relativePath, classifyLink, message-contract) và tách src/text-utils.ts để test được (C6). |
| 0.5.21 | 2026-07-11 | Fix: gutter đánh số riêng cho từng mục bullet/list (mọi độ sâu) thay vì chỉ hiện số dòng đầu của cả danh sách. |
| 0.5.22 | 2026-07-11 | Fix: Cmd/Ctrl+X không cắt được vùng chọn — thêm fallback qua Clipboard API vì webview lồng của VS Code không luôn bắn sự kiện 'cut'. |
| 0.5.23 | 2026-07-11 | Fix: mục list gõ thêm khi soạn không hiện số dòng (chỉ hiện sau undo) — refreshFromMarkdown ghi data-line mới trở lại DOM để ResizeObserver không xoá số của mục mới. |
| 0.6.0 | 2026-07-11 | Release: đồng bộ số phiên bản package.json với các fix/feature 0.5.15–0.5.23 đã tích lũy (type-safe messages, split pipeline, security/perf hardening, gutter list). |
| 0.6.1 | 2026-07-11 | Fix: click vào checkbox task-list không đổi trạng thái check/uncheck do preventDefault khiến browser revert lại property sau click. |
| 0.6.2 | 2026-07-11 | Fix: nút checkbox toolbar bấm lần 2 để bỏ checkbox lại còn trơ bullet thay vì về đoạn văn thường. |
| 0.6.3 | 2026-07-11 | Feature: đổi tên extension thành "Orca Editor" (name, menu chuột phải tab, settings), đổi tên file build thành orca-editor-0.6.0.vsix. |
| 0.6.4 | 2026-07-11 | Fix: hết 2 warning khi build vsce — thêm field repository vào package.json và tạo file LICENSE. |
| 0.6.5 | 2026-07-11 | Feature: chuẩn bị publish Marketplace — bỏ private:true, thêm script publish, loại tài liệu nội bộ khỏi .vscodeignore. |
| 0.6.6 | 2026-07-11 | Fix: README tách "Install" (Marketplace) khỏi "Build from source" — hướng dẫn build.sh/install.sh cũ không còn đi kèm .vsix nên gây nhầm lẫn cho end-user. |
| 0.6.6 | 2026-07-11 | Chore: gộp build.sh/install.sh/build-and-install.sh thành 1 file build.sh (subcommand build/install), loại khỏi gói .vsix. |
| 0.6.6 | 2026-07-11 | Fix: đổi tên 3 setting từ markdownWysiwyg.* sang orcaEditor.*; autoOpenToc/showLineNumbers áp dụng ngay khi đổi setting, không cần mở lại preview. |
| 0.6.6 | 2026-07-11 | Chore: đổi command ID và viewType từ markdownWysiwyg.* sang orcaEditor.* để nhất quán với tên setting. |
| 0.6.6 | 2026-07-11 | Fix: dịch toàn bộ chuỗi tiếng Việt hiển thị cho người dùng (toolbar, mục lục, tìm kiếm, bảng, thông báo) sang tiếng Anh. |
| 0.6.6 | 2026-07-11 | Fix: đồng nhất version trong package.json/package-lock.json với CHANGELOG.md và Update History.md (0.6.0 → 0.6.6). |
| 0.6.6 | 2026-07-11 | Chore: thêm THIRD-PARTY-NOTICES.md liệt kê license của toàn bộ dependency được bundle (mermaid, dompurify, katex...). |
| 0.6.6 | 2026-07-11 | Feature: thêm icon extension (cá heo xanh) tại images/icon.png, khai báo trong package.json. |
| 0.6.6 | 2026-07-11 | Fix: nút ¶/H1-H3 đổi tag qua execCommand thay vì thao tác DOM thô — undo hoàn tác đúng từng bước, không còn reset toàn bộ định dạng. |
| 0.6.6 | 2026-07-11 | Fix: nút code block khi chọn text giữa câu — tách đúng phần trước/sau vùng chọn thành đoạn riêng thay vì để trình duyệt tự tách lộn xộn. |
| 0.6.6 | 2026-07-11 | Fix: tooltip toolbar không hiện ở một số icon — thay title attribute gốc bằng tooltip tự vẽ qua mouseenter/focus, hiển thị nhất quán mọi nút. |
| 0.6.6 | 2026-07-11 | Fix: toolbar bị xô xuống dòng 2 khi cửa sổ hẹp — chuyển sang menu tràn "..." gom các nút định dạng không đủ chỗ. |
| 0.6.6 | 2026-07-11 | Fix: dịch nốt 2 chuỗi tiếng Việt còn sót (tooltip tick tìm kiếm, thông báo lỗi Mermaid) sang tiếng Anh. |
| 0.6.6 | 2026-07-11 | Fix: nút checkbox toolbar chỉ đổi item chứa caret khi chọn nhiều dòng bullet — nay convert toàn bộ dòng đang chọn, undo hoạt động đúng. |
| 0.6.6 | 2026-07-11 | Feature: tự ẩn panel mục lục khi tab hẹp hơn nửa màn hình (split editor); user vẫn tự bật lại được qua nút toolbar. |
| 0.6.6 | 2026-07-11 | Fix: chuyển đổi giữa bullet/numbered/task list không convert được (bấm nút bullet trên task list chỉ tắt cả list) — bỏ checkbox trước khi đổi kiểu list. |
| 0.6.6 | 2026-07-11 | Fix: đổi kiểu list nhiều dòng chỉ áp lên dòng cuối, tách rời khỏi list gốc kèm dòng trống dư — re-select đúng phạm vi trước execCommand, dọn `<p>` rỗng còn sót. |
| 0.6.6 | 2026-07-11 | Fix: bấm checkbox ép đổi luôn danh sách số (1.) sang dạng gạch đầu dòng (-) — bỏ checkbox nay giữ nguyên kiểu list, sửa CSS để số thứ tự vẫn hiện đúng. |
| 0.6.6 | 2026-07-11 | Fix (triệt để): chọn nhiều dòng text thường bấm task list chỉ dòng đầu có checkbox — dò lại từ selection sau execCommand thay vì reference DOM cũ, gộp mọi case về một đường xử lý chung. |
| 0.6.6 | 2026-07-11 | Fix: khoảng trắng thừa đầu dòng sau khi bỏ checkbox (chuyển task list về bullet/số) — cắt dấu cách mà markdown-it-task-lists để sót lại trong text khi gỡ checkbox. |
| 0.6.6 | 2026-07-11 | Feature: thêm sample song ngữ EN/JP (SAMPLE_EN_JP.md) đủ mọi format để test preview với tiếng Nhật. |
| 0.6.6 | 2026-07-11 | Feature: thêm subcommand `release` vào build.sh — kiểm tra git sạch, đăng nhập vsce, bump version, test, đóng gói, publish Marketplace và tag git; kèm `--dry-run`. |
| 0.6.7 | 2026-07-11 | Release: nâng version lên 0.6.7, gom toàn bộ fix/feature sau bản 0.6.6 vào một mục [0.6.7] trong CHANGELOG.md. |
| 0.6.8 | 2026-07-12 | Feature: highlight mọi vị trí khác trùng với text đang bôi đen trong file hiện tại, và icon tìm xuyên file trong project (bấm hoặc Ctrl/Cmd+Shift+F) với popover kết quả nhóm theo file. |
| 0.6.8 | 2026-07-12 | Feature: Enter ở dòng task list (kể cả trong ô bảng) tự tạo dòng mới cũng có checkbox, thay vì mất định dạng task. |
| 0.6.8 | 2026-07-12 | Fix: ordered task list ("1. [ ] ...") chỉ hiện checkbox, không hiện thêm số thứ tự "1." gây rối mắt. |
| 0.6.8 | 2026-07-12 | Fix: bấm H1/H2/H3 làm mất vị trí con trỏ, bấm lại lần 2 không revert về đoạn văn thường — dùng execCommand('formatBlock') riêng khi đổi TỪ heading (insertHTML bị Chrome lờ đi hoặc rò rỉ style sang block liền sau), khôi phục đúng offset caret khi tạo heading mới. |
| 0.6.8 | 2026-07-12 | Fix: highlight trong kết quả tìm xuyên file bị mất hút khi popover hẹp/dòng dài — cắt ngữ cảnh 40 ký tự mỗi bên quanh match trước khi render, thay vì phó mặc CSS ellipsis cắt mất luôn cả phần highlight. |
| 0.6.8 | 2026-07-12 | Feature: icon tìm xuyên file tự ẩn sau 3s (pause khi hover/focus); debounce hiện icon 750ms + huỷ khi copy/cut/Backspace/Delete; icon neo bubble phía trên vùng chọn, cuộn theo tài liệu. |
| 0.6.8 | 2026-07-12 | Fix: click kết quả tìm xuyên file trỏ tới .md không cuộn tới đúng vị trí match — forward line/character qua message init/scrollToPosition, cả khi file đã mở sẵn ở tab khác. |
| 0.6.8 | 2026-07-12 | Feature: thước overview bên phải cho highlight khi select text (Feature A) — chỉ báo trực quan, tắt hẳn khi Ctrl+F đang mở, throttle 150ms/cap 500 tick tránh giật với file dài. |
| 0.6.8 | 2026-07-12 | Feature: thêm option Match Case/Whole Word (mặc định Whole Word ON) cho Ctrl+F và tìm xuyên file, word-boundary Unicode-aware cho tiếng Việt, fallback tự động về substring khi 0 kết quả. |
| 0.6.8 | 2026-07-12 | Fix: caret sai vị trí (trước checkbox thay vì sau) khi tạo task item mới hoặc Enter xuống dòng trong task list. |
| 0.6.8 | 2026-07-12 | Fix: click kết quả tìm xuyên file chỉ scroll, không select đoạn text khớp — forward character/length qua reveal/scrollToPosition, select trong block đơn dòng. |
| 0.6.8 | 2026-07-12 | Feature: thước overview khi select text (Feature A) thêm tick riêng cho vị trí đang chọn (màu cam) để so sánh với các match khác. |
| 0.6.8 | 2026-07-12 | Fix: icon Whole Word dễ nhầm với toggle chữ hoa/thường — đổi sang icon "ab" có vạch biên; icon Match Case/Whole Word đổi màu accent khi bật. |
| 0.6.8 | 2026-07-12 | Fix: tạo task list từ nhiều đoạn văn rời bị thừa bullet "•" ở dòng đầu — Chrome tách nhiều `<ul>` độc lập, nay quét cả vùng chọn thay vì chỉ 1 list. |
| 0.6.8 | 2026-07-12 | Fix: icon tìm xuyên file không tự ẩn sau 3s — bỏ qua mouseenter dư vị trí chuột trong 400ms đầu sau khi icon hiện, tránh pause timer vĩnh viễn. |
| 0.6.8 | 2026-07-12 | Feature: dán ảnh từ clipboard vào editor — lưu file thật vào images/ cạnh file .md (hoặc thư mục tuỳ chỉnh qua setting), chèn `<img>` với đường dẫn tương đối. |
| 0.6.8 | 2026-07-12 | Fix: icon tìm xuyên file giữ nguyên hình kính lúp, đổi màu sang accent vàng/cam (giống 💡) cho dễ nhận biết hơn. |
| 0.6.8 | 2026-07-12 | Fix: dán ảnh Cmd/Ctrl+V tạo 2 file/2 link ảnh trùng nhau — chặn trùng 500ms giữa fallback Clipboard API và 'paste' event thật cùng xử lý 1 lượt dán. |
| 0.6.8 | 2026-07-12 | Feature: thêm dải viewport band trên thước overview (Ctrl+F/select-highlight), đánh dấu vùng đang cuộn tới, cập nhật live theo scroll. |
| 0.6.8 | 2026-07-12 | Feature: khi save, tự dọn ảnh dán mồ côi (paste nhầm rồi undo) theo prefix tên file .md, chuyển vào images/.trash thay vì xoá cứng. |
| 0.6.8 | 2026-07-12 | Fix: icon tìm xuyên file không bao giờ tự ẩn — thiếu CSS `.cross-file-search-icon[hidden]{display:none}` nên `icon.hidden=true` bị rule `display:inline-flex` cùng độ đặc hiệu ghi đè. |
| 0.6.8 | 2026-07-12 | Fix: follow link kết quả tìm xuyên file highlight lệch vị trí — offset thô (raw markdown) lệch với text đã render; nay dùng matchText làm mỏ neo tìm lại trong DOM. |
| 0.6.8 | 2026-07-12 | Fix: tạo task list từ nhiều đoạn văn rời bị thừa bullet + dòng trắng (list loose/tách nhiều `<ul>`) — tự dựng một `<ul>` tight duy nhất bằng insertHTML thay vì execCommand. |
| 0.6.8 | 2026-07-12 | Fix: xoá dòng cuối bullet/task list làm heading kế tiếp bị gộp thành bullet — thêm handler Backspace/Delete xoá vắt ranh giới list mà giữ nguyên danh tính block hai đầu. |
| 0.6.8 | 2026-07-12 | Fix: ảnh mồ côi bị xoá cứng ngay khi save (bỏ .trash); undo xoá ảnh tự khôi phục lại file thật, xử lý như đang paste ảnh mới. |
| 0.6.8 | 2026-07-12 | Feature: click vào ảnh trong editor đặt caret ngay bên phải ảnh, cho phép Enter xuống dòng ngay sau ảnh. |
| 0.6.8 | 2026-07-12 | Release: nâng version lên 0.6.8, gom toàn bộ feature/fix sau bản 0.6.7 (tìm xuyên file, dán ảnh, select-highlight, task list, fix list/task/gutter) vào mục [0.6.8]; publish lên Marketplace. |
| 0.6.9 | 2026-07-12 | Fix (packaging): loại WIP/, Requirement/, Plan/ khỏi .vsix publish — các thư mục này bị đóng gói nhầm ở 0.6.8; không đổi tính năng editor. |
| 0.6.9 | 2026-07-12 | Feature: đổi tên extension thành "Orca MD Editor", id marketplace thành hungvu.orca-md-editor (do tên cũ orca-editor bị khóa sau khi lỡ vsce unpublish=delete); giữ nguyên namespace orcaEditor.* nội bộ. |
| 0.6.9 | 2026-07-13 | Feature: nút Heading gộp thành 1 split-button (mặc định H2, caret mở dropdown Paragraph/H1–H6), giữ nguyên hành vi toggle-về-paragraph (US-4.9). |
| 0.6.9 | 2026-07-13 | Feature: nút Code block gộp thành 1 split-button (mặc định JavaScript, caret mở dropdown 10 ngôn ngữ), giữ nguyên hành vi tách before/pre/after (US-4.10). |
| 0.6.9 | 2026-07-13 | Feature: thêm nút Math split-button (mặc định inline $...$, caret mở dropdown Inline/Block $$...$$), render KaTeX ngay qua ctx.insertMarkdown (US-4.11). |
