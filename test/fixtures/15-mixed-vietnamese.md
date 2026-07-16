# Requirement - Use Case: "Tạo và Gửi Yêu Cầu Nghỉ Phép"

## 1. Mô tả

### 1.1. Nội dung

Nhân viên có thể tạo và gửi yêu cầu nghỉ phép đến Quản lý dự án (Project Manager) để xác nhận. Hệ thống tự động:

- Tạo mã yêu cầu nghỉ phép với định dạng `LR-[5 chữ số]`.
- Ghi nhật ký theo dõi (audit log) khi thực hiện các thao tác liên quan.
- Cập nhật trạng thái yêu cầu nghỉ phép.

### 1.2. Các bước

| # | Bước | Người thực hiện | Mô tả |
| --- | --- | --- | --- |
| 1 | Chọn nghiệp vụ | Nhân viên | Chọn chức năng "Tạo yêu cầu nghỉ phép" trên màn hình danh sách nghiệp vụ. |
| 2 | Nhập thông tin | Nhân viên | Nhập các thông tin như: loại nghỉ, nguyên nhân, thời gian bắt đầu/thấm kết thúc. |
| 3 | Tạo yêu cầu | Hệ thống | - Tự động tạo mã yêu cầu với định dạng LR-&lt;5 chữ số&gt;.<br>- Ghi nhật ký theo dõi (log) nghiệp vụ.<br>- Hiển thị thông báo trên màn hình và lưu yêu cầu vào hệ thống. |
| 4 | Gửi yêu cầu | Hệ thống | Tự động gửi email thông báo đến Quản lý dự án (Project Manager) để xác nhận. |

## 2. Business Rules

- `[5 chữ số]` được tạo tự động từ `00001` đến `99999`.
- Nếu người dùng không nhập đủ thông tin yêu cầu, hệ thống hiển thị cảnh báo và dừng quy trình.
- Hệ thống chỉ gửi email thông báo đến địa chỉ email của Quản lý dự án (Project Manager) mà người dùng đã chọn.

## 3. Pre-Condition

- [ ] Người dùng đã đăng nhập hệ thống
- [x] Người dùng có quyền tạo yêu cầu nghỉ phép

> **Lưu ý:** Trạng thái ban đầu của yêu cầu là *Chờ xác nhận*.
