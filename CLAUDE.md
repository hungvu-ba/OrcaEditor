# CLAUDE.md

## Quy tắc bắt buộc: Update History

Mỗi khi sửa một lỗi (bug fix) hoặc thêm một tính năng (feature), phải ghi lại một dòng ngắn gọn (tối đa 30 từ) vào file \[Update History.md\](Update History.md) ở thư mục gốc.

Cấu trúc bảng:  `Date | Update Content`

-   **Date**: ngày thực hiện thay đổi, định dạng `YYYY-MM-DD`.
-   **Update Content**: mô tả ngắn gọn, tối đa 30 từ, nêu rõ đây là fix hay feature.

Thêm dòng mới vào cuối bảng, không sửa các dòng cũ.

## Quy tắc bắt buộc: Git workflow

Khi thực hiện bất kỳ thao tác git nào (branch, commit, merge, PR, release, hotfix, worktree...), phải đọc và tuân theo [Plan/GIT_WORKFLOW.md](Plan/GIT_WORKFLOW.md) — file này định nghĩa cấu trúc branch, quy ước commit, vòng đời feature/release/hotfix, và cách trình bày (giải thích cho người mới + sitemap trạng thái sau mỗi commit).
