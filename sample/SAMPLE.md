# Requirement - Use Case: "Tạo và Gửi Yêu Cầu Nghỉ Phép"

## 1\. Mô tả

### 1.1. Nội dung

Nhân viên có thể tạo và gửi yêu cầu nghỉ phép đến Quản lý dự án (Project Manager) để xác nhận. Hệ thống tự động:

-   Tạo mã yêu cầu nghỉ phép với định dạng `LR-[5 chữ số]`.
-   Ghi nhật ký theo dõi (audit log) khi thực hiện các thao tác liên quan.
-   Cập nhật trạng thái yêu cầu nghỉ phép.

### 1.2. Các bước

| # | Bước | Người thực hiện | Mô tả |
| :-: | --- | --- | --- |
| 1 | Chọn nghiệp vụ | Nhân viên | Chọn chức năng "Tạo yêu cầu nghỉ phép" trên màn hình danh sách nghiệp vụ. |
| 2 | Nhập thông tin | Nhân viên | Nhập các thông tin như: loại nghỉ, nguyên nhân, thời gian bắt đầu/kết thúc. |
| 3 | Tạo yêu cầu | Hệ thống | \- Tự động tạo mã yêu cầu định dạng LR-<5 chữ số>.<br>\- Ghi nhật ký theo dõi (log) nghiệp vụ.<br>\- Hiển thị thông báo và lưu yêu cầu vào hệ thống.<br>\- |
| 4 | Gửi yêu cầu | Hệ thống | Tự động gửi email thông báo đến Quản lý dự án để xác nhận.<br>\- dfdfsd<br>1\. dfdsfs<br>2\. dfs<br><br>\- |

## 2\. Business Rules

-   `[5 chữ số]` được tạo tự động từ `00001` đến `99999`.
-   Nếu người dùng không nhập đủ thông tin yêu cầu, hệ thống hiển thị cảnh báo và dừng quy trình.
-   Hệ thống chỉ gửi email đến địa chỉ của Quản lý dự án mà người dùng đã chọn.

## 3\. Pre-Condition

-   [x]  Người dùng đã đăng nhập hệ thống
-   [ ]  Người dùng có quyền tạo yêu cầu nghỉ phép

## 4\. Ví dụ code

```javascript
function generateRequestId(sequence) {
  return `LR-${String(sequence).padStart(5, "0")}`;
}
```

> **Lưu ý:** Trạng thái ban đầu của yêu cầu là *Chờ xác nhận*.

Công thức tính số ngày nghỉ còn lại: $R = T - U$ trong đó $T$ là tổng quota, $U$ là số ngày đã dùng.

---

Chi tiết xem thêm tại [tài liệu nghiệp vụ](https://example.com/docs) hoặc liên hệ admin@example.com.

-   fdsfds
-   sdfdsf
-   fdsfds
-   d

<pre><font face="Menlo, Monaco, Courier New, monospace">sequenceDiagram<br><br></font></pre>
