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
