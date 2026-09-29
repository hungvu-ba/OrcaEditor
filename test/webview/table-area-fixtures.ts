/**
 * US-19.27 area fit: shared table fixtures for the measure adapter spec, GATE A
 * (T1.3) and the fit integration (T1.4). Each is a markdown table copied verbatim
 * from sample/table-scenarios/.
 */

/** 01-width-distribution.md #1 One long description column + many short columns. */
export const TABLE_1 = `| ID | Status | Owner | Priority | Due | Est. | Description |
| --- | --- | --- | --- | --- | --- | --- |
| T-101 | Open | An | P1 | 2026-10-02 | 3d | Migrate the legacy invoice export job from the nightly cron server to the new event-driven pipeline, keeping the CSV column order identical so that downstream finance macros keep working without changes, and add a reconciliation report that flags any row whose total differs from the ERP ledger by more than one cent. |
| T-102 | Done | Binh | P3 | 2026-09-20 | 1d | Fix typo in footer. |
| T-103 | Review | Chi | P2 | 2026-10-05 | 5d | Replace the hand-rolled retry loop in the payment gateway client with the shared backoff helper, cap total retry time at 30 seconds, surface the final error code to the checkout page instead of a generic "something went wrong" message, and log every attempt with a correlation id so support can trace a failed payment end to end across the three services involved. |
| T-104 | Open | Dung | P2 | 2026-10-09 | 2d | Update logo. |
| T-105 | Blocked | An | P1 | 2026-10-01 | 8d | Waiting on legal sign-off for the new data retention policy; once approved, implement automatic purge of customer attachments older than 24 months, including backups, with a dry-run mode that emails a summary of what would be deleted to the compliance mailbox one week before the first real run. |
`;

/** 01-width-distribution.md #4 Many columns, all medium-length. */
export const TABLE_4 = `| Requirement | Actor | Precondition | Trigger | Main flow | Alternate flow | Postcondition | Business rule | UI screen | Test reference |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Register for an event | Visitor with account | Event is open for booking | Clicks "Register now" | Selects ticket type and quantity | Sold out → join waitlist | Booking created as pending | Max 4 tickets per visitor | Event detail page | TC-REG-001 to TC-REG-012 |
| Cancel a booking | Visitor with booking | Event starts in more than 48h | Clicks "Cancel booking" | Confirms cancellation reason | Within 48h → contact support | Seats released to the pool | Refund issued within 5 days | My bookings page | TC-CAN-001 to TC-CAN-006 |
| Approve group booking | Event coordinator | Group size above 10 people | Receives approval request | Reviews and approves the group | Rejects with a written reason | Group booking confirmed | Needs deposit of 30 percent | Coordinator dashboard | TC-GRP-001 to TC-GRP-009 |
| Check in at the gate | Gate staff | Visitor holds a valid QR code | Scans the visitor's ticket | System marks ticket as used | Invalid QR → manual lookup | Attendance count updated | One scan per ticket only | Gate scanner app | TC-CHK-001 to TC-CHK-004 |
`;

/** 02-content-types-alignment.md #8b Vietnamese diacritics and CJK text. */
export const TABLE_8B = `| Mã | Tiếng Việt | 日本語 | 中文 | English |
| --- | --- | --- | --- | --- |
| VN-01 | Người dùng phải xác nhận địa chỉ thư điện tử trước khi đặt vé tham quan bảo tàng. | ユーザーは博物館の入場券を予約する前にメールアドレスを確認する必要があります。 | 用户在预订博物馆门票之前必须确认电子邮件地址。 | Users must verify their email before booking a museum ticket. |
| VN-02 | Hủy vé trước 48 giờ được hoàn tiền đầy đủ. | 48時間前までのキャンセルは全額返金されます。 | 提前48小时取消可全额退款。 | Full refund if cancelled 48h ahead. |
| VN-03 | Ưu đãi | 割引 | 优惠 | Discount |
| VN-04 | Khách đoàn trên mười người cần đặt cọc ba mươi phần trăm và được điều phối viên phê duyệt trước ngày diễn ra sự kiện. | 10名を超える団体は30%の前金が必要で、イベント前にコーディネーターの承認を受ける必要があります。 | 超过十人的团体需要支付百分之三十的定金，并在活动前获得协调员的批准。 | Groups over ten need a 30% deposit and coordinator approval. |
`;

/** 04-mode-state-divergence.md #20 Uneven row heights + middle vertical alignment. */
export const TABLE_20 = `| Risk | Likelihood | Impact | Mitigation | Contingency | Owner |
| --- | --- | --- | --- | --- | --- |
| Payment gateway outage during a ticket launch | Medium | High | Pre-warm the gateway with the provider, negotiate a higher rate limit for launch days, and queue payment attempts on our side with idempotency keys so they can be replayed safely | Switch to the secondary gateway via feature flag; extend the booking hold from 10 to 30 minutes so visitors don't lose their seats | An |
| Low | Low | Low | — | — | Binh |
| Data leak through exported CSV reports shared by email | Low | High | Strip personal fields from exports by default, watermark every export with the requesting user and timestamp, and expire download links after 24 hours | Revoke all active links, notify the DPO within 72 hours, and rotate API keys used by the reporting service | Chi |
| Front desk staff unfamiliar with the new check-in app | High | Medium | Two training sessions, a laminated quick guide at each gate | Keep paper lists for the first two weeks | Dung |
`;
