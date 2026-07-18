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
| 0.6.9 | 2026-07-13 | Feature: kết quả tìm xuyên file (US-15.6) đổi sang accordion theo file — cap ưu tiên số file thay vì tổng match, badge/overflow đúng số thật, "+N match khác" mở Search panel scope đúng 1 file. |
| 0.6.9 | 2026-07-13 | Feature: xếp hạng kết quả tìm xuyên file (US-15.7) theo fileScore — heading/definition/vị trí/tên file/độ hiếm từ khoá, thay vì thứ tự tìm thấy. |
| 0.6.9 | 2026-07-14 | Feature: kết quả tìm xuyên file (US-15.6) — file chỉ 1 match show thẳng snippet luôn, bỏ accordion cho riêng case này; ≥2 match vẫn giữ accordion như cũ. |
| 0.6.9 | 2026-07-14 | Feature: mở rộng popover kết quả tìm xuyên file (US-15.9) từ 320×360px lên 400×min(70vh,560)px, giữ nguyên cơ chế neo/clamp vị trí. |
| 0.6.9 | 2026-07-13 | Feature: nút Heading gộp thành 1 split-button (mặc định H2, caret mở dropdown Paragraph/H1–H6), giữ nguyên hành vi toggle-về-paragraph (US-4.9). |
| 0.6.9 | 2026-07-13 | Feature: nút Code block gộp thành 1 split-button (mặc định JavaScript, caret mở dropdown 10 ngôn ngữ), giữ nguyên hành vi tách before/pre/after (US-4.10). |
| 0.6.9 | 2026-07-13 | Feature: thêm nút Math split-button (mặc định inline $...$, caret mở dropdown Inline/Block $$...$$), render KaTeX ngay qua ctx.insertMarkdown (US-4.11). |
| 0.6.9 | 2026-07-13 | Feature: thêm nút chèn nhanh sơ đồ Mermaid mẫu (flowchart Start/Decision/End) qua ctx.insertMarkdown (US-4.12). |
| 0.6.9 | 2026-07-13 | Feature: thêm nút Clear formatting (eraser) trong cụm Edit cạnh Undo/Redo — execCommand("removeFormat") trên vùng chọn (US-4.13). |
| 0.6.9 | 2026-07-13 | Feature: gộp nút Copy @file/View raw source vào popover "more options" (⋮) cạnh TOC, thay vì luôn hiện — phân biệt icon với "..." tràn (US-4.14). |
| 0.6.9 | 2026-07-13 | Feature: nút Bold/Italic/Strike/Inline code/Blockquote/Bullet/Numbered/Task tự sáng theo caret (selectionchange), loại trừ Heading/Code block/Math (US-4.15). |
| 0.6.9 | 2026-07-13 | Fix: nút Heading hiện đúng cấp heading (H1–H6) tại caret thay vì luôn tĩnh "H2" (US-4.16). |
| 0.6.9 | 2026-07-13 | Feature: popup chèn Link/Image kéo-thả được (drag handle riêng, không dịch chuyển lớp nền mờ) (US-17.2). |
| 0.6.9 | 2026-07-13 | Fix: bỏ "Markdown" khỏi danh sách ngôn ngữ dropdown code block — còn 9 ngôn ngữ (US-4.10). |
| 0.6.9 | 2026-07-13 | Feature: công thức Math (KaTeX) chèn xong sửa lại được — nút toggle công thức ⇄ TeX thô, giống Mermaid (US-4.18). |
| 0.6.9 | 2026-07-14 | Fix: popup chèn Link/Image kéo được từ bất kỳ đâu trên box, không chỉ 1 thanh handle mỏng — trừ input/nút/gợi ý file (US-17.2). |
| 0.6.9 | 2026-07-14 | Fix: dịch nốt text tiếng Việt còn sót trong toolbar sang tiếng Anh — badge "Phổ biến"→"Common", nút toggle Mermaid "Xem mã nguồn/biểu đồ"→"View source/chart". |
| 0.6.9 | 2026-07-14 | Feature: sửa công thức Math (KaTeX) qua popup nổi có textarea + gợi ý cú pháp, thay toggle inline cũ — không đè công thức, hết bug caret lạc (US-4.19). |
| 0.6.9 | 2026-07-14 | Feature: nút Mermaid thêm dropdown 4 loại sơ đồ (Flowchart/Sequence/Class/State) thay vì chỉ 1 flowchart cố định (US-4.20). |
| 0.6.9 | 2026-07-14 | Fix: popup sửa công thức KaTeX cho resize textarea 2 chiều, kéo thả cả popup, cheat-sheet hiện cú pháp ngay trên nút (US-4.22). |
| 0.6.9 | 2026-07-14 | Fix: chèn Mermaid/math block từ toolbar tự thêm dòng trống sau khối để đặt caret; rà mọi khối atom liền kề đều có chỗ caret ngay sau. |
| 0.6.9 | 2026-07-14 | Docs: đồng bộ Requirement - 15 (US-15.6/15.7/15.9 Shipped) và HLR từ worktree cross-file-search-v3 vào dự án chính; không đổi code. |
| 0.6.9 | 2026-07-14 | Docs: cập nhật design-log kiến trúc theo code mới nhất; lập plan refactor Block-Indexed Architecture — HLR mục 18 + Requirement - 18 (US-18.1–18.3, 📝 Planned). |
| 0.6.9 | 2026-07-14 | Feature: popover kết quả tìm xuyên file kéo-thả được, dùng chung makeDraggable() với popup Insert Link/Image và popup sửa Math (US-17.1). |
| 0.6.9 | 2026-07-14 | Fix: click kết quả tìm xuyên file ngoài viewport bị nhảy về caret cũ — set selection trước, scrollIntoView smooth sau cùng + focus preventScroll để không cắt ngang animation. |
| 0.6.9 | 2026-07-14 | Fix: Ctrl+F Next tới match ngoài viewport rồi bấm ra content bị nhảy về caret cũ — đóng search box giờ focus() có preventScroll, không tự cuộn về caret. |
| 0.6.9 | 2026-07-14 | Feature: US-18.1 Block Map — module block-map.ts (id/type/srcRange/mdSlice), gutter refactor đọc chung, bail-out thu hẹp. |
| 0.6.9 | 2026-07-14 | Fix: code block mới chèn qua toolbar không có syntax highlight, chỉ hiện sau khi save/mở lại — nay hljs.highlightElement ngay tại chỗ. |
| 0.6.9 | 2026-07-14 | Fix: chèn code block khi vùng chọn xuyên nhiều đoạn (kể cả qua đoạn trắng) làm nhân đôi nội dung — xoá đúng hết mọi block nằm giữa. |
| 0.6.9 | 2026-07-14 | Feature: tách test roundtrip theo feature (test/roundtrip/*.ts, chạy riêng từng cái); thêm test cho toolbar/input-rules/math-edit/paste-image, phát hiện bug insertImage() mất ổn định với path có dấu cách. |
| 0.6.9 | 2026-07-14 | Fix: insertLink()/insertImage() (toolbar) không encode path tương đối có dấu cách, làm markdown đổi hình dạng khi lưu/mở lại — nay encodeLinkPath() trừ URL tuyệt đối. |
| 0.6.9 | 2026-07-14 | Feature: HLR mục 19 Readability — Reading Mode (nút toolbar + 4 preset), measure ch, palette đọc (Sepia…), typography, Zen, zoom ảnh, table content-aware sizing, ARIA/reduce-motion; state lưu ở orcaEditor.readability.*. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 #2/#3/#6): đổi nút "Zen" → "Focus Mode"; nâng min-width cột table 8ch→14ch (panel hẹp scroll ngang thay vì wrap từng từ); TOC không tự bật khi file không có heading. |
| 0.6.9 | 2026-07-15 | Feature (US-19.10, bug 0715 #7): thêm control chọn reading palette lên toolbar (Follow VS Code mặc định / Light / Dark / Sepia / High-contrast), đánh dấu palette đang áp; setPalette tự bật Reading Mode như setPreset (trừ followTheme trung tính) — fix "lệch màu" khi chuyển tab. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 #1): Focus Mode ẩn toolbar bằng position:fixed overlay thay vì sticky+transform (hết cảnh "ẩn nửa thanh"); và bấm Reading/Focus không còn tự bật TOC (configUpdate chỉ auto-open khi cờ autoOpenToc đổi). |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 #5): Comfortable Reading dùng font của VS Code (bỏ ép serif) như preset Default, chỉ giữ giãn dòng/thu hẹp cột. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 #1): mở rộng dải hover ở mép trên (4px→64px, ẩn lại ở 120px) để dễ rê chuột mở lại toolbar trong Focus Mode. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 #4): trạng thái Reading Mode/preset/palette/Zen chuyển sang per-tab session-only — không còn ghi config Global nên bật ở 1 tab không lan sang tab khác; Settings chỉ là default cho tab mới. |
| 0.6.9 | 2026-07-15 | Fix (paste ảnh): đo naturalWidth/devicePixelRatio khi dán, chèn width để ảnh giữ kích thước gốc thay vì bị max-width:100% kéo full bề ngang cửa sổ; ảnh to hơn cửa sổ vẫn thu nhỏ cho vừa. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 đợt2 #4): Focus Mode không còn tự hiện lại toolbar khi rê chuột xuống ngay sau khi bấm Focus — thêm cơ chế "arm": chỉ reveal sau khi con trỏ đã rời dải trên một lần. |
| 0.6.9 | 2026-07-15 | Fix (bug 0715 đợt2 #1): toolbar/popover/table-toolbar đổi màu theo reading palette (kế thừa --rp-*), hết cảnh chrome tối lệch với vùng chữ sepia/ivory. |
| 0.6.9 | 2026-07-15 | Feature (US-19.11, bug 0715 đợt2 #3): reading palette thành lớp theme GLOBAL, độc lập Reading Mode — đổi palette 1 tab .md áp cho mọi tab và nhớ qua Settings; Reading Mode/Focus vẫn per-tab. |
| 0.6.9 | 2026-07-15 | Tinh chỉnh UI (US-19.11): dời nút "Color" (reading palette) xuống cuối nhóm phải toolbar (sau TOC, cạnh menu "...") vì palette là theme global ít khi đổi, không nên chiếm ô giữa Read/Focus. |
| 0.6.9 | 2026-07-15 | Fix (UI): preset đang chọn trong dropdown Reading Mode giờ có dấu ✓ giống dropdown palette đọc (US-19.10) — dùng chung helper syncDropdownSelection. |
| 0.6.10 | 2026-07-15 | Feature (US-19.13): reading palette phủ nốt chrome còn lại (TOC, hộp tìm, popup link/ảnh/TeX, tìm chéo file, toast) + tô selection & màu chữ search-highlight theo palette cho đủ tương phản. |
| 0.6.10 | 2026-07-15 | Fix (US-19.13): embedded block (math/mermaid/code/front-matter) đọc rõ như "card" theo palette — thêm --rp-elev-bg/--rp-embed-border, math block có nền+viền, viền các khối đậm hơn, nút Edit/View source theo màu palette. |
| 0.6.9 | 2026-07-15 | Fix (scroll): heading không còn bị toolbar sticky che khi nhảy heading/anchor/reveal source line — thêm scroll-padding-top = chiều cao toolbar (đo động qua --toolbar-height). |
| 0.6.9 | 2026-07-15 | Feature (UI default): mặc định khi mới cài đổi sang Comfortable Reading + palette Sepia; "Follow VS Code" (preset/palette) là trung tính — không sáng nút, không dấu ✓, badge Default dời sang Sepia. |
| 0.6.10 | 2026-07-15 | Feature (US-19.14): sticky table header — cuộn bảng dài qua dòng tiêu đề thì header cột "dính" dưới toolbar (clone nổi ngoài #content, đồng bộ scroll ngang), luôn đọc được tên cột. |
| 0.6.10 | 2026-07-15 | Fix (US-19.14): sticky table header bị lệch cột dần sang phải — clone th thiếu box-sizing:border-box nên width (đo border-box) bị cộng thêm padding/viền; thêm border-box để cột dính khớp thẳng cột thân bảng. |
| 0.6.10 | 2026-07-15 | Feature (US-19.15): reading mode "Academic Paper" theo look ai-2027.com — preset serif "sách" cột hẹp ~62ch (no-bundle) + palette "Paper" nền kem trắng ấm #fffff8; 2 lever độc lập, ghép cho trọn style. |
| 0.6.10 | 2026-07-15 | Feature (US-19.6): mỗi reading preset có cỡ chữ nền riêng qua --reading-font-size (Comfortable 16 / Compact 13 / Dyslexia 18px; Default giữ VS Code) — heading em tự co giãn theo, cả type scale đồng bộ. |
| 0.6.10 | 2026-07-15 | Feature (US-19.15): preset Academic Paper đặt cỡ chữ nền 19px (essay serif kiểu ai-2027.com ~ET Book 20px) — hoàn thiện bộ --reading-font-size theo preset. |
| 0.6.10 | 2026-07-15 | Feature (US-19.6): TOC + pop-up (popover/prompt/search) phóng cỡ chữ theo preset qua --reading-ui-font-size (Comfortable/Academic 14 / Compact 12 / Dyslexia 15px; Default giữ VS Code) — chrome đồng bộ với vùng đọc. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #1): Focus Mode reveal không còn che dòng đầu tài liệu — chỉ khi toolbar hiện mới chừa padding-top (đẩy chữ xuống cùng nhịp trượt), ẩn thì về 0; gỡ reveal khi chuột rời webview/mất focus; giữ reveal khi dropdown đang mở. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715, US-19.9): mở tab khi Zen bật — bake class đọc vào HTML từ provider + chặn transition lúc seed, toolbar ẩn ngay từ first paint, hết giật/trượt; animation chỉ khi bấm Focus. |
| 0.6.10 | 2026-07-15 | Feature (TOC readability): heading dài đọc rõ hơn — panel mục lục rộng hơn (260→300px) + kéo đổi rộng được (nhớ giữa các lần mở), và mục đang hover/đang đọc bung đủ chữ thay vì cắt "…". |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #1): padding đẩy chữ khi reveal toolbar Focus Mode chỉ áp khi ở gần đỉnh tài liệu (.reading-zen-reveal-push); reveal giữa trang chỉ phủ tạm, không xê dịch content; cuộn lên đỉnh khi đang reveal tự nâng cấp thành đẩy. |
| 0.6.10 | 2026-07-15 | Fix (Reading Mode measure): heading nhô quá cột chữ, lề phải ngắn hơn body — do `--reading-measure` đo bằng `ch` theo font-size to của heading; chia lại theo tỉ lệ em (h1÷2, h2÷1.5, h3÷1.25, h5÷0.875, h6÷0.85) để heading chung mép cột với `<p>`, giữ nguyên `ch`. |
| 0.6.10 | 2026-07-15 | Feature (US-19.15): bundle font Literata (OFL, subset Latin+Vietnamese) vào preset Academic Paper — đứng đầu stack, render giống nhau mọi OS và đủ dấu tiếng Việt (thay Iowan Old Style thiếu dấu). |
| 0.6.10 | 2026-07-15 | Feature (US-19.1): sắp lại thứ tự dropdown Reading Mode theo tần suất dùng — Comfortable → Academic Paper → Compact → Default → Dyslexia-friendly. |
| 0.6.10 | 2026-07-15 | Feature (US-19.15): Academic Paper tự dò ngôn ngữ tài liệu — tiếng Anh dùng ET Book (bundled, MIT, đúng font ai-2027.com) + Palatino fallback; tiếng Việt dùng Literata (đủ dấu). |
| 0.6.10 | 2026-07-15 | Fix (Reading Mode width system): thiết kế lại hệ độ rộng cột 2 tầng — prose (text/heading/hr/list/blockquote = --reading-measure) vs wide (table/code/math/mermaid = --reading-container ~1.14× measure), chung mép trái. Heading đo bằng % container (miễn nhiễm weight/letter-spacing/mono), thu hẹp container mọi preset để bảng/embedded rộng vừa phải không lệch; hr căn trái. |
| 0.6.10 | 2026-07-15 | Fix (table column width): cột nội dung ngắn (vd "#") không còn bị ép rộng bằng sàn 14ch — co vừa nội dung (fitTableColumns), cột dài vẫn giữ sàn chống wrap vụn; sticky header refresh khi gõ trong ô bảng. |
| 0.6.10 | 2026-07-15 | Fix (cross-file search): dịch chuỗi empty-state sang tiếng Anh; thêm quy tắc CLAUDE.md: output dự án luôn English, chỉ chat trả lời tiếng Việt. |
| 0.6.10 | 2026-07-15 | Feature (US-17.3, M1): drag & drop reorder for top-level blocks — hover handle, heading section-move, single-undo-step move via execCommand; roundtrip tests added. |
| 0.6.10 | 2026-07-15 | Feature (US-17.4, M2): drag reorder table rows/columns (single-undo-step even for columns); fixed self-drop no-op bug shared with M1 in new sibling-move.ts. |
| 0.6.10 | 2026-07-15 | Feature (US-17.5, M3): drag reorder list items (nested sub-tree included) and horizontal-drag indent/outdent via native execCommand. |
| 0.6.10 | 2026-07-15 | Feature (US-17.6, M4): drag images/files from Explorer/Finder into the editor, saved to assets/. Breaking: renamed config orcaEditor.pasteImage.* to orcaEditor.assetsPaste.*, default folder images/ to assets/ (no migration of existing images). |
| 0.6.10 | 2026-07-15 | Feature (US-17.7, M5): handle menu (Move up/down/to a heading) and TOC-item drag both reorder sections; standalone image paragraphs already draggable via M1, confirmed with a test. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #1): drag handle no longer hides on mouseleave when the cursor moves onto it; only hides when hovering a different block. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #2): block and table row/column drag handles reposition on scroll instead of staying frozen at stale coordinates. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #3): table toolbar gap above the table increased (6→28px) so it no longer overlaps the column drag handle. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #4): table column autofit no longer ratchets wider only — clears stale inline min-width before remeasuring so columns can shrink again. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #5): Focus Mode padding-top is now always reserved instead of toggled by toolbar reveal, removing the layout jump. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #6): TOC font-family now follows the Reading Mode preset, hoisted onto body like the existing font-size/palette pattern. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #7): hyperlinks are always underlined by default now, not only on hover or via Reading Mode's opt-in toggle. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #8): TOC items always wrap to show the full heading text instead of ellipsis-truncating with a tooltip fallback. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #9): pasted image width measurement is now awaited before insert, fixing a race that could drop the width attribute. |
| 0.6.10 | 2026-07-15 | Feature (US-19.17, bug 0715 #7): link underline color/thickness/weight/background now adapt per reading preset (dyslexia, academic, others); removed dead linkUnderline setting. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #3): pasted images always lost their width (CSP blocked the blob: URL used to measure them); now measured via an already-allowed data: URL instead. |
| 0.6.10 | 2026-07-15 | Feature (US-19.18): Reading Mode dropdown now lists 10 curated preset+palette bundles + "Follow VS Code"; hover live-previews the palette colors; removed the separate Color/Palette toolbar control. |
| 0.6.10 | 2026-07-15 | Tooling: added bmad-quick-dev and bmad-testarch-automate skills (ported from Dev/.cursor/skills) to .claude/skills/ for spec-driven implementation and test-automation workflows. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #2): TOC items truncate with ellipsis + native tooltip instead of wrapping to 2 lines; truncation now tracks the resizable panel width. |
| 0.6.10 | 2026-07-15 | Feature (US-19.18 follow-up): Reading Mode dropdown hover now previews full typography/measure too, not just palette colors; fixed a self-reflow bug by locking each row's font-size inline while the dropdown is open. |
| 0.6.10 | 2026-07-15 | Fix (US-19.18): "Follow VS Code" in the Reading Mode dropdown did nothing while Focus/Zen mode was on, since Zen alone keeps reading styling active; disable() now also exits Zen. |
| 0.6.10 | 2026-07-15 | Feature (US-19.18): reading style dropdown hover now debounces 120ms before previewing (skip rows the cursor just passes over) and color changes ease in over 0.18s instead of snapping instantly. |
| 0.6.10 | 2026-07-15 | Fix (US-19.18): hovering between two rows in the reading style dropdown now transitions directly from the current preview to the new one, instead of snapping back to the committed style first. |
| 0.6.10 | 2026-07-15 | Feature: scale up main toolbar 1.25x (button/icon/separator size) — was too small, hard to click precisely. |
| 0.6.10 | 2026-07-15 | Fix: Zen mode toolbar hover-reveal zone now scales with real toolbar height instead of hardcoded 64/120px, easier to hit. |
| 0.6.10 | 2026-07-15 | Fix (US-19.18): clicking the main Reading Mode icon to turn it off now reuses disable() (also exits Zen) instead of just flipping `enabled`, which looked like a no-op while Zen was on. |
| 0.6.10 | 2026-07-15 | Feature (US-19.18): moved "Follow VS Code" to the top of the Reading Mode dropdown (was last), separated from the 10 style bundles by a divider — faster access to the reset action. |
| 0.6.10 | 2026-07-15 | Fix (US-19.19): TOC panel now starts below the toolbar instead of overlapping it — toolbar no longer shrinks/gets covered inconsistently between Zen and Normal mode when TOC is open. |
| 0.6.10 | 2026-07-15 | Feature (US-19.20): Zen/Focus mode is now global across all open .md tabs (session-only, not persisted to Settings) instead of per-tab — toggling it in one tab switches every open tab. |
| 0.6.10 | 2026-07-15 | Tweak: narrowed the Zen mode toolbar keep-visible hover margin (HIDE_MARGIN_PX 96→76px) per feedback that it was too wide. |
| 0.6.10 | 2026-07-15 | Fix (US-19.19 revert): TOC panel moved back to top:0 (the below-toolbar fix left its sideBar background not reaching the screen top, looking like a floating box); toolbar now overlaps it via z-index (100→160, above TOC's 150) instead, matching how Zen mode already worked. |
| 0.6.10 | 2026-07-15 | Feature (US-19.19): "TABLE OF CONTENTS" panel title font-size bumped to H2 scale (11px → 1.5em, matches h2 in markdown.css and scales with the user's configured font size). |
| 0.6.10 | 2026-07-15 | Feature: truncated TOC headings now show a custom-drawn tooltip on hover/focus (reusing the toolbar's tooltip module), consistent with icon buttons. |
| 0.6.10 | 2026-07-15 | Feature: TOC no longer auto-opens on file open when the document has only 1 heading (was: only suppressed for 0 headings) — a single-entry TOC adds no navigation value. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #6): image zoom button now clamps below the sticky toolbar instead of overlapping it for images near the top of the document. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #5): reading palette default was "sepia" instead of "followTheme" for newly opened tabs; corrected in package.json/provider.ts/readability.ts. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #13): inline code font-size trimmed to 0.9em with em-based padding, so formatted spans no longer visually outsize surrounding text across every reading mode. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #14): cross-tab Zen broadcast landing during a panel's init handshake no longer animates the toolbar slide; steady-state broadcasts still animate normally. |
| 0.6.10 | 2026-07-15 | Feature (bug 0715 #12): hover-highlight outline around the block/list-item/row/column under the cursor, synced with the existing drag handles. |
| 0.6.10 | 2026-07-15 | Fix (bug 0715 #7/#8/#9): list-item handle clears wide markers, nested list ancestors get a reachable handle, table row/col handles no longer hide before click. |
| 0.6.10 | 2026-07-15 | Tooling: added a Playwright-based webview interaction test track (test/webview/, real Chromium execCommand/Selection API) to cover interactive bugs domino/unit tests can't reproduce; wired into `npm run test`. |
| 0.6.10 | 2026-07-16 | Feature: added TOC heading-level filter slider (H1/H1-H2/H1-H2-H3, per-tab persisted); removed TOC drag & drop entirely (bug 0716 #7/#9). |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #1): Zen toolbar no longer flashes visible then slides away on cold-open — hidden state now baked as inline style instead of depending on external CSS load timing. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #3-#6): exclusive nested-list handle, larger flush hit-area (block/li/row/col), kebab merged into handle click, hover outline now shows only while a handle is held. |
| 0.6.10 | 2026-07-16 | Fix: TOC heading-filter slider moved into its own full-width bar with H1/H2/H3 labels, no longer hidden under the toolbar; also fixes bug 0716 #8's toolbar/TOC color mismatch. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #4 follow-up): drag handle (block/li/row/col) no longer disappears when the mouse overshoots past its now-narrower hit area in one fast move. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 round 2): column handle glyph rotated 90° to match its wide/short shape; table margin-top increased so the handle no longer overlaps the line above. |
| 0.6.10 | 2026-07-16 | Fix: dragging a table row could merge its content into a neighboring row and wipe the other cells — row move now relocates the real DOM node instead of replacing it via HTML string. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #8, root cause): TOC panel background now uses the same theme-token order as the toolbar, removing the color seam a padding-only fix had left in some themes. |
| 0.6.10 | 2026-07-16 | Fix: toolbar's B/I/S buttons now render bold/italic/strikethrough respectively, matching the formatting they apply instead of plain text labels. |
| 0.6.10 | 2026-07-16 | Feature (bug 0716 #2, US-19.21): Reading Mode (enabled/preset/palette) reversed from per-tab to global across all open tabs, matching Zen mode's existing scope. |
| 0.6.10 | 2026-07-16 | Fix: a table's header row had no drag handle at all (row-hover only scanned tbody rows). |
| 0.6.10 | 2026-07-16 | Feature: click a row handle to promote that row to become the table's header ("Set as header row"), swapping it with the old header in place. |
| 0.6.10 | 2026-07-16 | Fix: Zen mode + line-number gutter combo zeroed out the left margin, clipping the drag handle at the viewport edge. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #10): Task List button no longer stacks duplicate checkboxes onto unrelated list items on repeated clicks; added idempotency + turndown guards. |
| 0.6.10 | 2026-07-16 | Fix: drag ghost preview no longer shows a double blue outline and now matches the dragged block/li/row/column's real on-screen size instead of an unrelated auto-sized box. |
| 0.6.10 | 2026-07-16 | Fix: row-drag ghost content was inset by the ghost box's own padding, making it visibly narrower than the real row; column-drag ghost now shows a full-height column placeholder instead of just the tiny header cell. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 #10 follow-up): checkbox-stacking guards now also recognize a loose-list item's checkbox nested in its child `<p>`, not just a direct `<li>` child. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 round 2 #4): table column drag ghost now clones the real column content (header + every cell) instead of an empty placeholder box. |
| 0.6.10 | 2026-07-16 | Fix: drag ghost's own 480px max-width was clamping every normal-width block/heading, re-wrapping its text narrower than the real editor content; ghost now matches the real block width. |
| 0.6.10 | 2026-07-16 | Fix: block/list-item drag ghost's bottom padding clipped the last line of wrapped text — height now grows to fit the content instead of being pinned to the source's raw height. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 round 2 #4 follow-up): table column drag ghost was clipped to 160px tall on tables with more than a few rows, no longer matching the real column height. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 round 3): top-level block moves now use Range deleteContents/insertNode instead of execCommand(insertHTML), fixing WebKit's smart-merge silently corrupting/duplicating neighboring blocks. |
| 0.6.10 | 2026-07-16 | Fix (bug 0716 round 2 #2): nested list item's own drag handle is now reachable on a cold mouse arrival, not just an already-hovered item; also fixes the same misresolution in loose lists' inter-item gaps. |
| 0.6.10 | 2026-07-16 | Fix: leaving the editor's content area leftward while hovering a nested list item's handle now shows the parent item's handle instead of freezing on the child. |
| 0.6.10 | 2026-07-16 | Feature (bug 0716 round 2 #1): tables now get their own drag handle at the top-left corner to reorder the whole table, alongside the existing row/column handles. |
| 0.6.10 | 2026-07-16 | Fix: list-item drag handle now sits left of the marker (no longer covers the bullet/number); moving left climbs to the parent item, then to a whole-list drag handle. |
| 0.6.10 | 2026-07-16 | Feature: Ctrl/Cmd+Z·Y now delegate undo/redo to the underlying TextDocument (single history) instead of contentEditable, restoring caret to the changed block after re-render. |
| 0.6.10 | 2026-07-16 | Fix: list-item drag handle now sits snug just left of each item's own number/bullet, so a nested item's handle no longer shares its parent's column. |
| 0.6.10 | 2026-07-16 | Fix: sliding the cursor left off a list item's handle now reveals the parent/whole-list handle even on a gradual move (previously only a single fast jump surfaced it). |
| 0.6.10 | 2026-07-16 | Fix: block-level elements (headings, paragraphs, list items, blockquote, hr, dl) had no left padding, so the drag hover outline sat flush against the text; added breathing room. |
| 0.6.10 | 2026-07-16 | Feature: drag hover-highlight outline now has a low-alpha tint of its own border color instead of no background, staying legible against text in any theme. |
| 0.6.10 | 2026-07-16 | Fix: dragged block's hover-outline background nearly vanished under its own 0.4 muted-opacity; also made drag outline/ghost colors follow Reading Mode's palette (was always VS Code blue, clashing with sepia/high-contrast). |
| 0.6.10 | 2026-07-16 | Fix: list-item drag handles are now a uniform height aligned to each item's own marker row, instead of a parent handle spanning its whole nested subtree. |
| 0.6.10 | 2026-07-16 | Feature: a list item's drag handle is now grabbable anywhere in its left gutter (tall invisible hit zone), not only on the small glyph — easier to grab a climbed parent. |
| 0.6.10 | 2026-07-16 | Feature: dragging a list item by its handle can now move it to a different nesting depth within the same list in one gesture, not just reorder among original siblings. |
| 0.7.0 | 2026-07-16 | Release: bumped version to 0.7.0, consolidating Reading Mode, drag & drop, toolbar redesign, TOC filter, and undo/redo delegation (US-4/17/18/19) into one \[0.7.0\] entry in CHANGELOG.md. |
| 0.7.0 | 2026-07-16 | Fix (packaging): excluded .claude/, _bmad*/, test-results/, playwright-report/ from the published .vsix — bundled by mistake (same class of bug as 0.6.9's fix). |
| 0.7.0 | 2026-07-16 | Refactor: "Copy @file for Claude" toolbar button generalized to a plain clipboard copy, removing Claude Code-specific tab detection and auto-insert. |
| 0.7.0 | 2026-07-16 | Test: added Phase 0 safety net (HLR 22, execCommand verb replacement) — characterization + RED clean-DOM-target + delete/cut hardening + roundtrip tests; no production code changed yet. |
| 0.7.0 | 2026-07-16 | Refactor: added shared list-ops primitive (computeIndent/computeOutdent/computeToList/commitListOp, HLR 22 Phase 1) plus its tests; not wired to any call site yet. |
| 0.7.0 | 2026-07-17 | Feature (US-18.4a): headings now keep their original ATX (#) vs. Setext (===/---) style on save instead of always normalizing to ATX. |
| 0.7.0 | 2026-07-17 | Feature (US-18.4b): bullets, code blocks, em/strong, HRs now keep their original per-block syntax on save; new defaults `*` bullets and `\` hard breaks. |
| 0.8.0 | 2026-07-17 | Release: bumped version to 0.8.0, consolidating heading/bullet/code-block/em-strong/HR style preservation (US-18.4a/18.4b) into one [0.8.0] entry in CHANGELOG.md. |
| 0.7.0 | 2026-07-16 | Fix: Shift+Tab outdent (HLR 22 Phase 2.1) now wired to computeOutdent/commitListOpDirect instead of raw execCommand — no more empty `<ul>` or styling-span artifact. |
| 0.7.0 | 2026-07-17 | Fix: Tab indent (HLR 22 Phase 2.2) now wired to computeIndent/commitListOp instead of raw execCommand — no more `ul > ul` sibling malformation. |
| 0.7.0 | 2026-07-17 | Fix: setBulletList's toggle-off/OL→UL-convert and toggleTaskItem's toggle-off sites (HLR 22 Phase 2.3) wired to new computeRetagListRange/computeUnwrapListRange — no more styling-span artifact or malformed list split. |
| 0.7.0 | 2026-07-17 | Fix: Tab/Shift+Tab pressed right after Enter (fresh empty list item) indented/outdented the WRONG item — caret restore now anchors to the moved item itself instead of a document-wide character offset that couldn't distinguish an empty sibling `<li>`'s start from the previous item's end. |
| 0.7.0 | 2026-07-17 | Fix: pressing Enter at the end of a non-last list item left a stray blank line in the saved markdown — turndown's default `<br>`/empty-`<li>` handling corrupted the output; two new rules serialize an empty list item cleanly. |
| 0.7.0 | 2026-07-17 | Fix: undo now follows edit chronology — toolbar actions flush pending typing first and commit as their own undo unit; toolbar Undo/Redo buttons delegate to TextDocument like Ctrl+Z/Y. |
| 0.7.0 | 2026-07-17 | Fix: word-boundary undo checkpoint now reads the caret-adjacent DOM character instead of inputType/data — Vietnamese diacritic (composed/IME) typing no longer merges multiple words into one undo step. |
| 0.8.0 | 2026-07-17 | Refactor/perf: shared `applyRange`/`emptyParagraph` helpers dedupe caret-restore and empty-`<p>` construction; `rankFileGroups` scores once before sort; `cleanupOrphanImages` reads each sibling `.md` once. |
| 0.8.0 | 2026-07-17 | Refactor/perf: rAF-coalesce TOC-resizer `updateActive`; sticky-header reuses table rect; `flatMap`/`filter` cleanups (gutter, search); readability `mutateAndNotify` dedup + dead-export removal; cross-file-search `pluralize`/`dismiss` helpers. |
| 0.8.0 | 2026-07-17 | Fix: selecting text with a blank line and clicking Bullet/Task List no longer creates an empty bullet/checkbox for that blank line. |
| 0.8.0 | 2026-07-17 | Refactor: shared `resetCaptureState` (render), `parseHtml` (sibling-move), `resolveInserted` (dom-utils); drop duplicate `placeCaretAfterCheckbox` for `placeCaretAtBlockStart`; table `flatMap`/template-literal cleanups. |
| 0.8.0 | 2026-07-17 | Fix: Numbered list button (HLR 22 Phase 2.4) wired to computeToList/computeRetagListRange instead of raw execCommand — no more `<p><ol>` leak when converting a plain paragraph. |
| 0.8.0 | 2026-07-17 | Refactor/perf: cross-file-search `el()` DOM helper + lazy-render match rows on expand; drag-drop caret-restore routed through `dom.placeCaretIn` (3x) and shared `attach/detachDragListeners`. |
| 0.8.0 | 2026-07-17 | Fix: heading/blockquote conversions (HLR 22 Phase 2.5/2.6) moved off execCommand formatBlock/insertHTML onto direct-Range insert — no nested-heading, style-leak, or p-revert-merge Chrome bugs. |
| 0.8.0 | 2026-07-17 | Refactor: toggleTaskItem's inline tight-`<ul>` workaround (HLR 22 Phase 2.7) consolidated onto shared resolveTopLevelBlocks + computeToList — one implementation with setBulletList/setNumberedList. |
| 0.8.0 | 2026-07-17 | Fix: refresh stale undo-chronology/granularity webview fixtures for the US-18.4b `*`-bullet + backslash-break defaults (4 failing tests); no app-code change. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group Backslash): broadened turndown `strayTrailingBr` rule strips a residual trailing `<br>` in `<li>`/`<p>`/`<blockquote>` so list/blockquote verb ops no longer leave a stray `\` on save. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group DragRefresh): Tab/Shift+Tab indent/outdent now calls `dragDrop.refresh()` so the drag handle no longer stays frozen over the moved `<li>`'s old position. |
| 0.8.0 | 2026-07-17 | Test (HLR 22 Group Targeting): strengthened Enter+Tab/Shift+Tab regression tests with nesting-depth + serialized-markdown asserts; verified the reported list-targeting bug does not reproduce, no app-code change. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group IndentCollapse): indent (Tab) onto a previous sibling's existing sublist now commits via `commitListOpDirect`, so loose lists no longer get phantom `<li>`s/blank-line artifacts. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group HrCaretTrap): a caret-trap `<p>` now precedes every mid-document `<hr>`, and `formatHeading` bails on a `#content`-root selection, so typing `>`/changing heading level near an `<hr>` no longer absorbs it. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group ListVerbBlankDrop): Bullet/Numbered/Task on a selection spanning an `<hr>`/table now route through `computeToListAroundAtoms` (atom kept, list splits around it) instead of the corrupting legacy execCommand path; blank lines still dropped. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Bug #12): `>` input rule on an empty paragraph now places the caret inside the new blockquote (with a `<br>` placeholder), so typed text no longer leaks out beside it. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group DragRefresh, mở rộng): typing (`input`) and "Move up/Move down" menu reorders now call `dragDrop.refresh()`, so the drag handle no longer stays frozen over a block's old position. |
| 0.8.0 | 2026-07-17 | Fix (HLR 22 Group TaskListFallback, Bug #11): Task List over a selection spanning a table/pre/blockquote/heading now splits the list around atoms (headings convert) via `commitListOpDirect`, replacing the corrupting legacy execCommand. |
| 0.8.0 | 2026-07-18 | Fix (bug_ExcelCommand #1): undo now restores the caret inside the edited list item (using each `<li>`'s own `data-line`) instead of jumping to the first bullet's start. |
| 0.8.0 | 2026-07-18 | Feature (bug_ExcelCommand #4): typing `> ` inside a blockquote now creates a nested blockquote (`> >`) instead of an escaped literal `\>`; Quote button strips the caret's own quote level and any deeper nested quotes, leaving higher levels intact. |
| 0.8.0 | 2026-07-18 | Fix (bug_ExcelCommand #3): Task List on one `<ol>` item now splits it into its own task `<ul>` (siblings stay numbered) instead of leaving `2. [ ] Bravo`. |
| 0.8.0 | 2026-07-18 | Fix (bug_ExcelCommand #2): an empty nested bullet (Tab-indent then Undo at TC2.2c) no longer serializes to a lone `-` line that re-parses as a setext heading; serialize now drops all-blank nested sublists. |
| 0.8.0 | 2026-07-18 | Test: add clean-on-open webview guard verifying that opening a `.md` file posts no `edit` (stays not-dirty) even for non-byte-faithful content (CRLF, hr, table, math/mermaid). |
| 0.8.0 | 2026-07-18 | Fix (bug_ExcelCommand #5): toggling a Task list item off now returns it to normal text (a paragraph), splitting the list and keeping sibling task items, instead of leaving a plain bullet. |
| 0.8.0 | 2026-07-18 | Feature (bug_General #3): hovering a drag handle glyph (block/list-item/table) now outlines its drag target so the user sees what will move; plain content hover still adds nothing (bug 0716 #6). |
| 0.8.0 | 2026-07-18 | Fix (bug_General #1): toggling Zen/Focus mode no longer forces Reading Mode styling on; reading styling now gates on Reading Mode only, so Zen keeps the current reading state (Zen and Reading Mode fully independent). |
| 0.8.0 | 2026-07-18 | Fix (bug_General #2): copying editor content now also writes formatted text/html to the clipboard, so pasting into external rich-text tools (email, Word) keeps formatting; text/plain stays Markdown for paste-back into the editor. |
| 0.8.0 | 2026-07-18 | Fix (bug_General #1): clicking a block/table handle now opens its menu clear of the block content and selects the whole block, deletable via Delete/Backspace. |
| 0.8.0 | 2026-07-18 | Fix (bug_General R2): handle menus (block/table/row) open clear of the selected element and below the toolbar; handle click no longer selects text; scroll locks while a menu is open. |
| 0.8.0 | 2026-07-18 | Refactor (Code Optimization Notes Group A): dedup 5 previously-blocked files — extract getAnchorElement/wireTriggerButton + drop dead mainOpensDropdown (toolbar), broadcastToOtherPanels/resolveAllowedAssetsDir (provider), serializeIfChanged/applyInlineFormat (main), commitListPlan/hasNestedSublist (list-ops), pickFence/outerHtmlFallback (turndown); behavior unchanged. |
| 0.8.0 | 2026-07-18 | Refactor (Code Optimization Notes Group B): dedup table.ts (attachDragListeners/detachDragListeners for the drag-listener trio) + input-rules.ts (finishTaskItem/applyOrderedStart for the task-checkbox and ordered-list-start tails); behavior unchanged. |
| 0.8.0 | 2026-07-18 | Refactor (Code Optimization Notes — re-triaged defers): shared readAsDataUrl/dataUrlToBase64 (dom-utils, dedup paste-image + external-drop), createToolbarToggle (dom-postprocess, dedup math/mermaid toolbar), and named message payload types (RevealPosition/AssetSaveResult/Zen/ReadingModeChanged in messages.ts); behavior unchanged. |
| 0.8.0 | 2026-07-18 | Feature: register Orca MD Editor with customEditor priority "default" so .md files (incl. followed links) open in Orca instead of raw text. |
| 0.8.0 | 2026-07-18 | Refactor + security (Optimization Notes): shared el() helper, toggleAttribute checkbox mirror, cellPrefix/rangeToInnerHtml/fillSequenceColumn dedup, zen toolbar-height rAF-coalesce; S-1/S-2 message-boundary validation. |
| 0.8.0 | 2026-07-18 | Fix: dropped non-image files now orphan-cleaned like pasted images — deleting the link removes+caches the asset (undo restores it) via per-document in-session tracking. |
| 0.8.0 | 2026-07-18 | Fix (bug General #2): heading block handle + hover-preview outline now span the whole section (heading + content), matching what a drag actually moves. |
| 0.8.0 | 2026-07-18 | Feature: heading Move Up/Down/"Move to"/drag now restricted to same-level sibling positions under the same parent heading; level changes stay separate (Tab/Shift+Tab). |
| 0.8.0 | 2026-07-18 | Fix (bug General #4): TOC auto-hides based on Comfortable Reading content width + live panel width, not half the physical screen. |
| 0.8.0 | 2026-07-18 | Feature (bug General #6): Mermaid diagrams get a toolbar "Zoom" button opening a fullscreen lightbox (scroll to zoom, drag to pan, Esc to close), sharing the image-zoom overlay. |
| 0.8.0 | 2026-07-18 | Feature (bug General #5): bare relative file paths render as clickable links labelled by file name (display-only); the raw path round-trips unchanged in the .md. |
| 0.8.0 | 2026-07-18 | Feature (bug General #5): a relative path written as inline code (backticks) is now Cmd/Ctrl+Click-openable while keeping its code style; the code span round-trips unchanged. |
| 0.8.0 | 2026-07-18 | Feature (bug General #5): auto-linked inline-code paths now display just the file name in link colour (code background kept); the .md still round-trips to the full `path`. |
| 0.8.0 | 2026-07-18 | Feature (bug General #10): TOC entries now render as bordered, rounded cards (subtle background, per-level indent) instead of flat hyperlinks; palette-aware in reading modes. |
| 0.8.0 | 2026-07-18 | Fix (bug General #10): TOC card text no longer painted as an underlined link on hover/active; the accent moved to the card border/background. |
| 0.8.0 | 2026-07-18 | Fix (bug General #10): TOC now rebuilds after toolbar heading-level changes (raw-DOM ops that skip 'input'), via scheduleSync — matching keyboard edits. |
| 0.8.0 | 2026-07-18 | Fix (bug General #7): code-block syntax highlighting and Mermaid diagrams now follow the active reading palette, not just the VS Code theme, so both stay readable on light palettes (e.g. Sepia). |
| 0.8.0 | 2026-07-18 | Feature (bug General #9): in a heading, Tab demotes / Shift+Tab promotes it and its descendant headings; Tab past H6 becomes a paragraph, Shift+Tab on H1 is a no-op. |
| 0.8.0 | 2026-07-18 | Fix (bug General R3 #1): clicking a block/table drag handle now opens the Move menu at the click point, not far below a tall block/section. |
| 0.8.0 | 2026-07-18 | Fix (bug2): undo after deleting a just-pasted image now restores it — the inverse paste↔delete pair is split so VS Code no longer merges them into one net-zero undo step. |
