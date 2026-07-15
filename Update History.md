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
