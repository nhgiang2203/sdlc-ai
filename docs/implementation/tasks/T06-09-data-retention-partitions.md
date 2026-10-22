# T06-09 — Lưu giữ dữ liệu vận hành: phân vùng analytics và nhật ký kiểm toán

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | SAD §7.4 (chính sách lưu giữ), CON-006, NFR-003 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-10](T01-10-analytics-events.md) (bảng phân vùng `ops.analytics_events`), [T05-05](T05-05-audit-log-api.md) (`ops.audit_log`, quyền chỉ thêm), [T06-06](T06-06-conversation-history-retention.md) (`retention_sweep`) |
| Chặn | [T07-03](T07-03-security-testing.md) (review bảo vệ dữ liệu) |
| Trạng thái | Todo |

## 1. Mục tiêu

Tự động hoá hai việc lưu giữ mà các task khác chưa nhận:
1. Tạo trước phân vùng tháng cho `ops.analytics_events` và xoá phân vùng cũ hơn **13 tháng**.
2. Xoá bản ghi `ops.audit_log` cũ hơn **2 năm**, mà vẫn giữ nguyên tắc nhật ký chỉ thêm (INV-05) với role ứng dụng.

## 2. Bối cảnh

- SAD §7.4: nhật ký kiểm toán giữ 2 năm (đề xuất), xoá phân vùng cũ; analytics giữ 13 tháng, xoá phân vùng tháng.
- T01-10 tạo sẵn phân vùng 2026-11 … 2027-12 cùng phân vùng `DEFAULT`, và ghi "job tạo phân vùng tháng mới gắn vào celery-beat ở T06-01". T06-01 không nhận việc này, nên task này nhận.
- T05-05 (OQ-T0505-02) chỉ ra `ops.audit_log` không phân vùng (§7.2), mâu thuẫn với "xoá phân vùng cũ" ở §7.4. Khối lượng nhật ký rất nhỏ (vài nghìn dòng/năm), nên task này **không phân vùng** `ops.audit_log` mà xoá theo `at` (đề xuất).
- T06-06 làm `retention_sweep` cho hội thoại (180 ngày) và xếp lại job kẹt. Task này thêm bước vào cùng lịch bảo trì nhưng tách thành task Celery riêng để dễ theo dõi.
- Không cần cho pilot 4 tuần, nhưng phải có trước go-live chính thức. Nếu không, phân vùng `DEFAULT` sẽ dần nhận dữ liệu từ 2028-01 và chính sách lưu giữ không được thực thi (Bảo mật thông tin sẽ hỏi trong review).

## 3. Phạm vi

**Trong phạm vi:**
- Task `maintain_partitions` (tạo trước 3 tháng, xoá phân vùng > 13 tháng).
- Task `purge_audit_log` (> 2 năm).
- Role CSDL riêng cho bảo trì.
- Cấu hình thời hạn, metric, log, test.

**Ngoài phạm vi:**
- Xoá hội thoại, message, feedback: [T06-06](T06-06-conversation-history-retention.md).
- Xoá object PDF: [T05-03](T05-03-document-removal-api.md).
- Vòng đời backup 30 ngày: [T07-02](T07-02-backup-restore-drill.md) và pgBackRest.

## 4. Thiết kế chi tiết

**Module**

| File | Nội dung |
|---|---|
| `backend/cwd/application/reporting/maintain_partitions.py` | Use case `MaintainAnalyticsPartitions(now, months_ahead=3, retain_months=13)` |
| `backend/cwd/application/reporting/purge_audit_log.py` | Use case `PurgeAuditLog(now, retain_days=730)` |
| `backend/cwd/adapters/postgres/partition_admin.py` | Thao tác DDL qua kết nối của role `cwd_maintenance` |
| `backend/cwd/entrypoints/worker/tasks/maintenance.py` | Task `maintain_partitions` (hằng ngày 02:30), `purge_audit_log` (hằng tuần, Chủ nhật 03:00); hàng đợi `maintenance`, timeout 10 phút |

**Phân vùng analytics**

```sql
-- Tạo phân vùng tháng nếu chưa có (lặp cho tháng hiện tại + 3 tháng tới)
CREATE TABLE IF NOT EXISTS ops.analytics_events_2028_01
  PARTITION OF ops.analytics_events FOR VALUES FROM ('2028-01-01') TO ('2028-02-01');

-- Xoá phân vùng có cận trên <= date_trunc('month', now()) - interval '13 months'
ALTER TABLE ops.analytics_events DETACH PARTITION ops.analytics_events_2026_11;
DROP TABLE ops.analytics_events_2026_11;
```

- Tên phân vùng lấy từ `pg_inherits` + `pg_class`, và chỉ xử lý tên khớp `^analytics_events_\d{4}_\d{2}$`. Không bao giờ đụng tới `analytics_events_default`.
- Trước khi tạo một phân vùng tháng mới: nếu `DEFAULT` đang có dòng thuộc tháng đó, PostgreSQL sẽ báo lỗi. Khi đó task chuyển các dòng sang phân vùng mới trong một giao dịch theo thứ tự `DETACH DEFAULT` → tạo phân vùng → `INSERT … SELECT` → `DELETE` → `ATTACH DEFAULT`, ghi log `warning` và tăng metric `cwd_partition_default_rows`.
- Advisory lock `pg_try_advisory_lock(hashtext('maintain_partitions'))` bảo đảm chỉ một worker chạy tại một thời điểm.

**Nhật ký kiểm toán**

```sql
DELETE FROM ops.audit_log WHERE at < now() - make_interval(days => :retain_days);
```

- Role ứng dụng `cwd_app` giữ nguyên quyền `INSERT, SELECT` (INV-05, T05-05).
- Tạo role `cwd_maintenance` (migration) chỉ có `DELETE` trên `ops.audit_log` và quyền sở hữu hoặc DDL trên các phân vùng `ops.analytics_events_*`. Credential riêng nằm trong secret store, và chỉ container worker hàng đợi `maintenance` được nạp credential này.
- Thêm chỉ mục btree(`at`) nếu chưa có. §7.2 đã có btree(`at DESC`), dùng được cho điều kiện này.

**Cấu hình:** `ANALYTICS_RETENTION_MONTHS=13`, `AUDIT_RETENTION_DAYS=730`, `PARTITIONS_AHEAD_MONTHS=3`. Các giá trị đều chờ OQ-013/OQ-019 chốt.

## 5. Các bước thực hiện

- [ ] Migration: role `cwd_maintenance` và quyền; xác nhận chỉ mục `at`.
- [ ] `PartitionAdmin` adapter + use case + unit test tính tháng (năm nhuận, chuyển năm).
- [ ] Task Celery + lịch beat; advisory lock.
- [ ] Integration test với Testcontainers (§7).
- [ ] Metric, log; thêm 2 dòng vào bảng "Cảnh báo" của dashboard hạ tầng (T06-04).
- [ ] Cập nhật runbook (T07-02): kiểm tra phân vùng, chạy thủ công, khôi phục khi task lỗi.

## 6. Tiêu chí hoàn thành

- [ ] Sau khi chạy, luôn có phân vùng cho tháng hiện tại và 3 tháng tới.
- [ ] Phân vùng có cận trên cũ hơn 13 tháng bị xoá; phân vùng `DEFAULT` không bị xoá.
- [ ] Bản ghi `ops.audit_log` cũ hơn 730 ngày bị xoá; role `cwd_app` vẫn không có quyền `UPDATE`/`DELETE` (test quyền của T05-05 vẫn xanh).
- [ ] Chạy lại nhiều lần không lỗi và không thay đổi gì thêm (idempotent); hai worker chạy cùng lúc thì chỉ một worker thực hiện.
- [ ] Chính sách §7.4 cho analytics và nhật ký được ghi vào tài liệu cho review Bảo mật thông tin (T07-03).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | Danh sách tháng cần tạo và cần xoá với `now` = 2027-01-15, 2027-12-31, 2028-02-29 |
| Integration | Bảng có phân vùng 2026-11..2027-12, giả lập `now` = 2029-01-10 → các phân vùng 2026-11..2027-12 bị xoá, các phân vùng 2029-01..2029-04 được tạo |
| Integration | Có dòng tháng 2028-01 nằm trong `DEFAULT` → task tạo phân vùng 2028-01 và chuyển dòng sang, không mất dữ liệu |
| Integration | `audit_log` có dòng 731 ngày và 729 ngày → chỉ dòng 731 ngày bị xoá |
| Quyền | Kết nối bằng `cwd_app` chạy `DELETE FROM ops.audit_log` → lỗi quyền |

## 8. Analytics / observability

- Metric: `cwd_maintenance_runs_total{task, outcome}`, `cwd_partitions_dropped_total`, `cwd_audit_rows_purged_total`, gauge `cwd_partition_default_rows`.
- Cảnh báo (đề xuất): `maintain_partitions` không thành công lần nào trong 48 giờ → Warning; `cwd_partition_default_rows > 0` → Warning.
- Log: tên phân vùng tạo/xoá, số dòng xoá. Không ghi nội dung sự kiện.

## 9. Tham chiếu

- SAD §7.1 (analytics phân vùng tháng, ADR-013), §7.2, §7.4, §11.1 (dữ liệu cá nhân), INV-05.
- [T01-10](T01-10-analytics-events.md), [T05-05](T05-05-audit-log-api.md) (OQ-T0505-02), [T06-06](T06-06-conversation-history-retention.md), [T06-01](T06-01-weekly-stats-api.md) (OQ-169).

## 10. Giả định và câu hỏi mở

- OQ-169 (từ T06-06): task này là câu trả lời đề xuất.
- OQ-T0505-02: đề xuất không phân vùng `ops.audit_log` và xoá theo `at`. Kiến trúc sư cập nhật SAD §7.4 cho khớp.
- OQ-013, OQ-019 (kế thừa): thời hạn lưu giữ chính thức và yêu cầu của Pháp chế về dữ liệu cá nhân trong nhật ký (`actor_id`, tên file).
- Giả định: `materialized view ops.weekly_stats` (T06-01) chỉ tổng hợp số liệu, nên xoá phân vùng cũ không làm mất số liệu tuần đã tính. Nếu view được refresh toàn phần thì các tuần cũ hơn 13 tháng sẽ biến mất, và điều này được chấp nhận theo §7.4.
