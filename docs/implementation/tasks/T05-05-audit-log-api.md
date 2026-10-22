# T05-05 — API nhật ký tài liệu + quyền CSDL chỉ thêm

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-007 · WP-52 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-04](T01-04-document-upload-api.md) (bảng `ops.audit_log`, ghi `DOCUMENT_UPLOADED`); liên quan [T01-02](T01-02-csrf-rbac-ratelimit-me.md) (RBAC vai trò `lead`), [T02-08](T02-08-ingestion-error-handling.md) (`DOCUMENT_FAILED`), [T05-03](T05-03-document-removal-api.md) (`DOCUMENT_REMOVED`) |
| Chặn | [T05-06](T05-06-fe-audit-page.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp `GET /api/v1/audit/documents` cho vai trò trưởng nhóm để xem ai đã đưa vào, gỡ hoặc gặp lỗi xử lý tài liệu nào và khi nào, lọc theo khoảng thời gian, mới nhất trước; bảo đảm nhật ký **chỉ thêm** ở mức quyền PostgreSQL (INV-05).

## 2. Bối cảnh

- SAD §4.4 router `audit` (vai trò `lead`, module `reporting`, `AuditLogQuery`), §5 `AuditEntry {id, actor_id, action, document_id, document_filename, at}`, INV-05, §7.2 `ops.audit_log` (`id bigserial`, btree(`at DESC`)), §7.4 (lưu 2 năm, "xoá phân vùng cũ"), §10.1 (phân trang cursor, `page_size` ≤ 100), §10.2 (403 `FORBIDDEN` khi không phải lead), §11.1 (RBAC theo claim nhóm `cwd-leads`, OQ-026).
- USER_STORIES US-007: tên tài liệu là bản sao để vẫn đọc được sau khi gỡ; role ứng dụng chỉ có `INSERT`/`SELECT`.
- Prototype `audit.html`: cột Thời điểm / Thao tác / Tài liệu / Người thực hiện; tác nhân "Hệ thống" cho `DOCUMENT_FAILED` kèm ghi chú lý do ("PDF dạng ảnh scan"); khoảng tối đa 90 ngày.

## 3. Phạm vi

**Trong phạm vi:** use case `AuditLogQuery`; route; validation khoảng thời gian; cursor; làm giàu tên người thực hiện và lý do lỗi; migration quyền `REVOKE/GRANT`; trigger chặn sửa/xoá; test phân quyền và quyền CSDL.

**Ngoài phạm vi:** trang giao diện ([T05-06](T05-06-fe-audit-page.md)); xoá dữ liệu hết hạn lưu giữ (2 năm — việc vận hành sau pilot, OQ-T0505-02); log đăng nhập trong Loki (SAD §11.1, T01-01).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/application/reporting/audit_log_query.py` | `AuditLogQuery(from_, to, cursor, page_size) -> AuditPage` |
| `backend/cwd/ports/repositories.py` | `AuditLogRepository.list(from_, to, after: (at, id) \| None, limit)` — chỉ đọc; `append(entry)` đã có |
| `backend/cwd/adapters/postgres/audit_repository.py` | SQL keyset |
| `backend/cwd/entrypoints/api/routers/audit.py` | `GET /audit/documents`, dependency `require_role("lead")` |
| `backend/migrations/versions/xxxx_audit_log_append_only.py` | Quyền + trigger |

### 4.2 Hợp đồng

`GET /api/v1/audit/documents?from=&to=&cursor=&page_size=`

| Tham số | Quy tắc |
|---|---|
| `from`, `to` | ISO-8601 có múi giờ (`2026-12-01T00:00:00+07:00`) hoặc UTC `Z`; `from` bao gồm, `to` **không** bao gồm (FE gửi đầu ngày hôm sau) |
| Mặc định | Thiếu cả hai → 30 ngày gần nhất (đề xuất); thiếu một → 400 |
| Ràng buộc | `from < to`; `to - from ≤ 90 ngày` (theo prototype, đề xuất) → ngược lại 400 `VALIDATION_ERROR` với `detail` tiếng Việt |
| `page_size` | 1..100, mặc định 50 |
| `cursor` | Opaque base64url của `{"at": "...", "id": 123}`; sai định dạng → 400 |

Response 200:

```json
{
  "items": [
    {
      "id": 1042,
      "at": "2026-10-20T09:21:00Z",
      "action": "DOCUMENT_FAILED",
      "actor": null,
      "document": { "id": "0192…", "filename": "GiayPhepKinhDoanh_Scan.pdf" },
      "error_reason": "scanned"
    }
  ],
  "next_cursor": "eyJhdCI6…"
}
```

- `actor`: `{id, display_name}` từ `access.users`; `null` khi `actor_id IS NULL` (worker ghi `DOCUMENT_FAILED`) → FE hiển thị "Hệ thống".
- `error_reason`: chỉ với `DOCUMENT_FAILED`, lấy từ `docs.documents.error_reason` qua `DocumentRepository.error_reasons(ids)` (application service ghép, không join chéo schema trong repository `ops`); lý do thay đổi sau (retry) thì hiển thị giá trị hiện tại (chấp nhận).
- Lỗi: 401 không có phiên; 403 `FORBIDDEN` khi không có vai trò `lead` (problem+json, `detail` "Bạn không có quyền xem trang này").
- Không có `POST/PUT/PATCH/DELETE` nào dưới `/api/v1/audit` (AC-US007-4).

### 4.3 Truy vấn

```sql
SELECT id, actor_id, action, document_id, document_filename, at
FROM ops.audit_log
WHERE at >= :from AND at < :to
  AND (:after_at IS NULL OR (at, id) < (:after_at, :after_id))
ORDER BY at DESC, id DESC
LIMIT :limit + 1;     -- dòng thừa → có next_cursor
```

Chỉ mục: thay btree(`at DESC`) bằng btree(`at DESC, id DESC`) (migration expand: tạo `CONCURRENTLY` rồi bỏ chỉ mục cũ).

### 4.4 Quyền PostgreSQL (INV-05)

Giả định role theo migration nền (T00-04): `cwd_owner` (sở hữu schema, chạy Alembic), `cwd_app` (API + Worker). Nếu T00-04 chưa tách role, migration này tạo `cwd_app` và cập nhật chuỗi kết nối runtime.

```sql
REVOKE ALL ON TABLE ops.audit_log FROM PUBLIC, cwd_app;
GRANT SELECT, INSERT ON TABLE ops.audit_log TO cwd_app;
GRANT USAGE ON SEQUENCE ops.audit_log_id_seq TO cwd_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA ops REVOKE UPDATE, DELETE, TRUNCATE ON TABLES FROM cwd_app;  -- phòng khi default privileges cấp ALL

CREATE FUNCTION ops.audit_log_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'ops.audit_log is append-only' USING ERRCODE = '42501'; END $$;
CREATE TRIGGER audit_log_no_update_delete BEFORE UPDATE OR DELETE ON ops.audit_log
  FOR EACH ROW EXECUTE FUNCTION ops.audit_log_append_only();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON ops.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION ops.audit_log_append_only();
```

Trigger là lớp phòng thủ thứ hai (chặn cả `cwd_owner` khi lỡ tay); xoá theo retention sau này phải `ALTER TABLE … DISABLE TRIGGER` có kiểm soát bởi DBA (OQ-T0505-02). INV-05 trong SAD ghi "`INSERT` only"; thực tế cần thêm `SELECT` để đọc (USER_STORIES US-007) — dùng `SELECT, INSERT`.

## 5. Các bước thực hiện

- [ ] Migration quyền + trigger + chỉ mục `(at DESC, id DESC)`.
- [ ] Repository `list` keyset; `AuditLogQuery` ghép `actor`, `error_reason`.
- [ ] Route + `require_role("lead")`; validation tham số.
- [ ] Test quyền CSDL bằng kết nối `cwd_app` thật.
- [ ] Ma trận phân quyền: `user`, `manager` → 403; `lead` → 200.
- [ ] OpenAPI.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US007-3:** người dùng không có vai trò `lead` gọi API → 403 `FORBIDDEN` (cả `user` và `manager`); không phiên → 401.
- [ ] **AC-US007-4:** không có endpoint nào sửa/xoá nhật ký (test liệt kê route); với kết nối `cwd_app`, `UPDATE`/`DELETE`/`TRUNCATE ops.audit_log` đều lỗi `42501`; với `cwd_owner`, `UPDATE`/`DELETE` bị trigger chặn.
- [ ] Hỗ trợ AC-US007-1 và AC-US007-2 (nghiệm thu ở T05-06): kết quả mới nhất trước; mỗi bản ghi có người thực hiện, loại thao tác, tên tài liệu (kể cả đã gỡ), thời điểm; chỉ trả bản ghi trong `[from, to)`.
- [ ] Phân trang ổn định: duyệt hết 1.000 bản ghi với `page_size = 50` không trùng, không sót (kể cả nhiều bản ghi cùng `at`).
- [ ] p90 ≤ 200 ms với 100k bản ghi (đề xuất).

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | Validation: thiếu một đầu, `from ≥ to`, > 90 ngày, cursor hỏng, `page_size = 0/101` |
| Integration (Testcontainers) | Seed 3 loại hành động, actor NULL, tài liệu đã gỡ; lọc biên `from`/`to` (đúng 00:00 +07:00); keyset với `at` trùng; quyền `cwd_app` (UPDATE/DELETE/TRUNCATE → 42501); trigger với owner |
| API / phân quyền | `user`/`manager`/`lead`; header CSRF không cần cho GET |
| Hiệu năng | 100k dòng, `EXPLAIN ANALYZE` dùng chỉ mục |

## 8. Analytics / observability

- Không có sự kiện analytics (PRD không định nghĩa sự kiện xem nhật ký).
- Log truy cập mức `audit` (`user_id`, `route`, `status`) — truy cập nhật ký kiểm toán cũng cần truy vết (đề xuất).

## 9. Tham chiếu

SAD §4.4, §5 (AuditEntry, INV-05), §7.2, §7.4, §10.1–10.2, §11.1; USER_STORIES US-007; prototype `audit.html`, `assets/mock-data.js` (`audit`); BRD BR-019.

## 10. Giả định và câu hỏi mở

- Giả định: worker ghi `DOCUMENT_FAILED` với `actor_id = NULL` (T02-08); nếu ghi `uploaded_by` thì FE hiển thị người tải lên thay vì "Hệ thống" — cần thống nhất (OQ-T0505-01).
- **OQ-T0505-01:** Tác nhân của `DOCUMENT_FAILED` là "Hệ thống" (prototype) hay người tải lên?
- **OQ-T0505-02:** SAD §7.4 nói xoá nhật ký sau 2 năm bằng "xoá phân vùng cũ", nhưng §7.2 không phân vùng `ops.audit_log`. Có phân vùng theo tháng/năm ngay từ bây giờ không? Đề xuất: không trong MVP (khối lượng nhỏ), quyết trước khi hết năm đầu.
- **OQ-T0505-03:** Giới hạn 90 ngày mỗi lần lọc (từ prototype) có được PO chấp thuận không?
