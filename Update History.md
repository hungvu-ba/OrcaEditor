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
