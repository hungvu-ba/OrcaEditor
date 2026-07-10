# Mermaid Sample

File này để thử tính năng hiển thị biểu đồ Mermaid trong WYSIWYG Preview. Mỗi khối bên dưới mặc định hiện **biểu đồ**; bấm nút **"Xem mã nguồn"** ở góc trên phải để chuyển sang xem/sửa mã `mermaid` gốc, bấm lại để quay về biểu đồ.

## 1\. Flowchart

```mermaid
flowchart TD
    A[Bắt đầu] --> B{Đã đăng nhập?}
    B -->|Chưa| C[Hiện màn hình đăng nhập]
    C --> D[Nhập tài khoản]
    D --> B
    B -->|Rồi| E[Vào trang chủ]
    E --> F[Kết thúc]
```

## 2\. Sequence Diagram

```mermaid
sequenceDiagram
    actor NV as Nhân viên
    participant HT as Hệ thống
    participant QL as Quản lý

    NV->>HT: Tạo yêu cầu nghỉ phép
    HT->>HT: Sinh mã LR-00001
    HT-->>NV: Xác nhận đã tạo
    HT->>QL: Gửi email yêu cầu duyệt
    QL-->>HT: Phê duyệt / Từ chối
    HT-->>NV: Thông báo kết quả
```

## 3\. Class Diagram

```mermaid
classDiagram
    class LeaveRequest {
        +String id
        +Date startDate
        +Date endDate
        +String status
        +submit()
        +approve()
        +reject()
    }
    class Employee {
        +String name
        +String email
        +createRequest() LeaveRequest
    }
    class Manager {
        +approve(LeaveRequest)
        +reject(LeaveRequest)
    }
    Employee "1" --> "many" LeaveRequest : tạo
    Manager "1" --> "many" LeaveRequest : duyệt
```

## 4\. State Diagram

```mermaid
stateDiagram-v2
    [*] --> ChoXacNhan
    ChoXacNhan --> DaDuyet: Quản lý duyệt
    ChoXacNhan --> TuChoi: Quản lý từ chối
    DaDuyet --> DaHuy: Nhân viên hủy
    DaDuyet --> [*]
    TuChoi --> [*]
    DaHuy --> [*]
```

## 5\. Entity Relationship Diagram

```mermaid
erDiagram
    EMPLOYEE ||--o{ LEAVE_REQUEST : creates
    MANAGER ||--o{ LEAVE_REQUEST : approves
    LEAVE_REQUEST {
        string id
        date startDate
        date endDate
        string status
    }
    EMPLOYEE {
        string name
        string email
    }
    MANAGER {
        string name
        string email
    }
```

## 6\. Gantt Chart

```mermaid
gantt
    title Kế hoạch triển khai tính năng Mermaid
    dateFormat  YYYY-MM-DD
    section Thiết kế
    Phân tích yêu cầu       :a1, 2026-07-01, 2d
    Thiết kế DOM/CSS        :a2, after a1, 2d
    section Triển khai
    Render + toggle button  :b1, after a2, 3d
    Round-trip test         :b2, after b1, 1d
    section Kiểm thử
    Kiểm thử thủ công       :c1, after b2, 1d
```

## 7\. Pie Chart

```mermaid
pie title Loại nghỉ phép đã dùng trong quý
    "Nghỉ phép năm" : 45
    "Nghỉ ốm" : 20
    "Nghỉ không lương" : 10
    "Khác" : 25
```

## 8\. Mã lỗi (kiểm tra fallback)

Khối dưới đây cố tình sai cú pháp — khi bấm sang xem biểu đồ sẽ tự động quay lại xem mã kèm thông báo lỗi thay vì hiển thị màn hình trắng.

```mermaid
flowchart TD
    A --> [đây không phải cú pháp Mermoid hợp lệ
```
