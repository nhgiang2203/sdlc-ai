# T05-03 — API gỡ tài liệu + task purge

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-005 · WP-51 |
| Loại | BE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T01-06](T01-06-ingestion-worker-embedding.md) (worker, khoá `lock:doc:{id}`), [T02-05](T02-05-ask-question-sse.md); liên quan [T02-08](T02-08-ingestion-error-handling.md) (DELETE tối thiểu cho tài liệu `FAILED`), [T02-01](T02-01-conversations-ownership.md) (`conv.citations`) |
| Chặn | [T05-04](T05-04-fe-document-removal.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Tổng quát hoá `DELETE /api/v1/documents/{id}` cho mọi trạng thái: trong **một giao dịch** đặt `REMOVED`, xoá pages/chunks, ghi audit — để tài liệu không còn được truy xuất ngay khi commit; chống gỡ trùng (409 `ALREADY_REMOVED`, một bản ghi audit); xoá object khỏi object storage trong ≤ 1 giờ bằng `purge_document`; citation cũ được đánh dấu `document_removed`.

## 2. Bối cảnh

- SAD §8.3 (5 bước luồng gỡ), §9.1 (`READY → REMOVED`, `FAILED → REMOVED`, `REMOVED → [*]` khi purge), §4.2 bảng tác vụ (`purge_document`: hàng đợi `maintenance`, 5 retry backoff mũ, timeout 5 phút), §5 INV-01 (chỉ chunk của tài liệu `READY`, `removed_at IS NULL`), INV-03 (`chunk_id → NULL`, giữ `document_title_snapshot`), §7.2 (`conv.citations.chunk_id` FK ON DELETE SET NULL), §7.4 (object xoá ≤ 1 giờ; backup hết hạn theo vòng 30 ngày), §10.2 (204, 404, 409 `ALREADY_REMOVED`; `Message.citations[].document_removed`), §4.3 (object versioning bật).
- BR-003: mọi người dùng được cấp quyền đều được gỡ (persona US-005 là PER-02 nhưng không giới hạn vai trò).
- T02-08 có DELETE tối thiểu cho `FAILED`; task này thay thế bằng use case chung `RemoveDocument`.

## 3. Phạm vi

**Trong phạm vi:** use case `RemoveDocument`; route DELETE; chặn đua với worker đang xử lý; task `purge_document` + đối soát định kỳ; cột `purged_at`; `document_removed` trong API hội thoại; EV-07 phía server; test.

**Ngoài phạm vi:** hộp thoại xác nhận, toast, nhãn trích dẫn đã gỡ ([T05-04](T05-04-fe-document-removal.md)); `GET /file` trả 410 (đã có ở [T04-01](T04-01-document-file-range-api.md)); API đọc nhật ký ([T05-05](T05-05-audit-log-api.md)).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/documents/document.py` | `Document.remove(actor_id, now)`: ném `AlreadyRemoved` nếu đã `REMOVED`; chuyển trạng thái hợp lệ từ mọi trạng thái khác |
| `backend/cwd/application/ingestion/remove_document.py` | `RemoveDocument(document_id, actor)` |
| `backend/cwd/application/ingestion/purge_document.py` | `PurgeDocument(document_id)` |
| `backend/cwd/ports/object_store.py` | `delete_all_versions(key)` |
| `backend/cwd/entrypoints/api/routers/documents.py` | `DELETE /documents/{id}` |
| `backend/cwd/entrypoints/worker/tasks/maintenance.py` | Task `purge_document`, `purge_reconcile` |
| `backend/migrations/versions/xxxx_documents_purged_at.py` | `ALTER TABLE docs.documents ADD COLUMN purged_at timestamptz NULL;` + partial index `(removed_at) WHERE removed_at IS NOT NULL AND purged_at IS NULL` |

### 4.2 Hợp đồng

`DELETE /api/v1/documents/{id}` — vai trò `user`, cần `X-CSRF-Token`.

| Kết quả | Mã |
|---|---|
| Gỡ thành công | 204 (không body) |
| Không tồn tại | 404 `NOT_FOUND` |
| Đã gỡ trước đó | 409 `ALREADY_REMOVED`, `detail` "Tài liệu đã được gỡ trước đó" |
| CSRF sai / thiếu | 403 (middleware T01-02) |

Rate limit: 60 lượt gỡ/giờ/người (đề xuất, chống thao tác hàng loạt nhầm; dùng token bucket sẵn có).

### 4.3 Giao dịch gỡ (`RemoveDocument`)

```sql
BEGIN;
SELECT id, status, filename, uploaded_at FROM docs.documents WHERE id = :id FOR UPDATE;
-- không có → 404; status = 'REMOVED' → ROLLBACK, 409
UPDATE docs.documents SET status = 'REMOVED', removed_at = now(), removed_by = :actor WHERE id = :id;
DELETE FROM docs.chunks WHERE document_id = :id;   -- citations.chunk_id → NULL (FK SET NULL)
DELETE FROM docs.pages  WHERE document_id = :id;
INSERT INTO ops.audit_log (actor_id, action, document_id, document_filename, at)
VALUES (:actor, 'DOCUMENT_REMOVED', :id, :filename, now());
COMMIT;
```

- Ghi audit qua `AuditLogPort` (module `reporting`) nhưng dùng **cùng session/giao dịch** (unit of work chung) để không có trạng thái gỡ mà thiếu audit.
- Sau commit: enqueue `purge_document(id)`; phát EV-07 `{document_id, age_days = floor((now - uploaded_at)/1 ngày)}` qua `ServerEventRecorder` (best-effort, lỗi chỉ ghi log). Enqueue lỗi → không trả lỗi cho người dùng; `purge_reconcile` sẽ xử lý.
- Hai request đồng thời: request thứ hai chờ khoá dòng, đọc `REMOVED` → 409; chỉ một bản ghi audit (AC-US005-4).
- Áp dụng cho `QUEUED`, `PROCESSING`, `READY`, `FAILED`. `FAILED` → cũng ghi `DOCUMENT_REMOVED` (đề xuất; thay hành vi T02-08 nếu chưa audit).

### 4.4 Đua với worker đang xử lý

Sửa `ProcessDocument` (T01-06): trong giao dịch ghi pages/chunks cuối cùng, `SELECT status FROM docs.documents WHERE id = :id FOR UPDATE`; nếu `REMOVED` → rollback, không ghi gì, kết thúc job thành công (không retry), log `ingest_aborted_removed`. Đầu job (`QUEUED → PROCESSING`) cũng bỏ qua nếu `REMOVED`. Như vậy tài liệu bị gỡ khi đang xử lý không bao giờ quay lại `READY` (SAD §9.1: `REMOVED` không quay lại trạng thái khác).

### 4.5 Purge

`purge_document(document_id)` — hàng đợi `maintenance`, `max_retries = 5`, backoff mũ 30 s → 8 phút có jitter, `time_limit = 300 s`, idempotent:

1. Đọc tài liệu; không `REMOVED` → log cảnh báo, kết thúc. `purged_at` đã có → kết thúc.
2. `ObjectStore.delete_all_versions("documents/{id}.pdf")`: `ListObjectVersions(Prefix=key)` → `DeleteObjects` cho mọi `VersionId` và delete marker; `NoSuchKey` coi là thành công.
3. `UPDATE docs.documents SET purged_at = now() WHERE id = :id`.

`purge_reconcile()` — Celery beat mỗi 15 phút (đề xuất): enqueue lại `purge_document` cho tài liệu `removed_at < now() - interval '10 minutes' AND purged_at IS NULL`. Đảm bảo ≤ 1 giờ ngay cả khi enqueue ban đầu mất (Valkey restart). Metric tuổi lớn nhất của tài liệu chưa purge.

### 4.6 Trích dẫn tài liệu đã gỡ

- `GET /conversations/{id}` (T02-01): `citations[].document_removed = true` khi `docs.documents.removed_at IS NOT NULL` (application service `GetConversation` gọi `DocumentRepository.removed_ids(document_ids)` — không join chéo schema trong repository `conv`).
- `document_title` lấy từ `document_title_snapshot` (INV-03). Câu trả lời đang stream khi gỡ vẫn hoàn tất; citation được ghi với `chunk_id` có thể đã NULL (EC-16).

### 4.7 Quyền PostgreSQL

Role ứng dụng `cwd_app` cần `UPDATE` trên `docs.documents`, `DELETE` trên `docs.chunks`, `docs.pages` (đã có từ migration nền); **không** cần quyền `DELETE`/`UPDATE` trên `ops.audit_log` (xem [T05-05](T05-05-audit-log-api.md)).

## 5. Các bước thực hiện

- [ ] Migration `purged_at` + chỉ mục.
- [ ] Phương thức domain `remove()` + unit test máy trạng thái.
- [ ] `RemoveDocument` với unit of work chung (documents + audit); route DELETE; thay route tối thiểu của T02-08.
- [ ] Sửa `ProcessDocument` kiểm tra `REMOVED` (đầu job + giao dịch cuối).
- [ ] `delete_all_versions` trong `S3ObjectStore` (+ fake); task `purge_document`; beat `purge_reconcile`.
- [ ] `document_removed` trong `GET /conversations/{id}`.
- [ ] EV-07 server-side (khai schema sự kiện ở danh mục của T01-10).
- [ ] Dòng mới trong ma trận test phân quyền.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US005-2:** ngay sau 204, câu hỏi chỉ có đáp án trong tài liệu vừa gỡ nhận `not_found` (integration: gỡ rồi hỏi trong cùng giây; không còn chunk nào của tài liệu trong `docs.chunks`).
- [ ] **AC-US005-4:** hai `DELETE` đồng thời → một 204, một 409 `ALREADY_REMOVED`; `ops.audit_log` có đúng một bản ghi `DOCUMENT_REMOVED` cho tài liệu (test đồng thời 20 lần lặp). Thông báo hiển thị ở FE do T05-04 làm.
- [ ] Hỗ trợ AC-US005-3: `GET /conversations/{id}` trả `document_removed = true`, `document_title` vẫn là tên cũ.
- [ ] Object (mọi phiên bản) bị xoá ≤ 1 giờ sau khi gỡ, kể cả khi Valkey restart ngay sau commit (test với reconcile).
- [ ] Gỡ tài liệu `PROCESSING` → worker không ghi chunk, trạng thái vẫn `REMOVED`.
- [ ] `GET /documents` không còn trả tài liệu đã gỡ; trùng sha256 không còn bị cảnh báo với bản đã gỡ.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `Document.remove` từ 5 trạng thái; `AlreadyRemoved` |
| Integration (Testcontainers PG + SeaweedFS có versioning) | Gỡ READY: chunks/pages = 0, citations.chunk_id NULL, audit 1 dòng; gỡ đồng thời; gỡ khi worker đang ở giữa (giả lập chặn worker bằng event) → worker abort; purge xoá 3 phiên bản object; purge chạy 2 lần (idempotent); reconcile nhặt tài liệu chưa purge |
| API | 204/404/409; thiếu CSRF → 403; người dùng không có vai trò → 403 |
| E2E (staging) | Tải PDF → READY → hỏi có trích dẫn → gỡ → hỏi lại → not_found; `GET /file` → 410 |

## 8. Analytics / observability

- EV-07 `document_removed` `{document_id, age_days}` (P1), ghi phía server (đề xuất; SAD §11.3 chưa liệt kê EV-07 trong danh sách server-side).
- Log `audit` mức `info` (`document_id`, `actor_id`, không có tên file).
- Metric: `cwd_document_removed_total`, `cwd_purge_failures_total`, `cwd_purge_pending_max_age_seconds` (gauge, cảnh báo khi > 3.600 s — đề xuất thêm vào T06-04).

## 9. Tham chiếu

SAD §4.2 (tác vụ bất đồng bộ), §4.3, §5 INV-01/INV-03/INV-05, §7.2, §7.4, §8.3, §9.1, §10.2; USER_STORIES US-005; PRD EC-16, EC-17, EC-22, EV-07; BRD BR-003, BRU-002.

## 10. Giả định và câu hỏi mở

- Giả định: unit of work của T01-04 đã hỗ trợ ghi `docs` + `ops.audit_log` trong một giao dịch (như audit `DOCUMENT_UPLOADED`).
- **OQ-T0503-01:** Có cho gỡ tài liệu đang `PROCESSING` không? Prototype vô hiệu nút; đề xuất API vẫn cho phép (an toàn nhờ §4.4), FE giữ như prototype.
- **OQ-T0503-02:** Xoá khỏi danh sách tài liệu `FAILED` có ghi `DOCUMENT_REMOVED` vào nhật ký không? Đề xuất có (truy vết đầy đủ).
- **OQ-T0503-03:** Có cần giới hạn quyền gỡ theo vai trò (chỉ `lead`) không? BR-003 nói mọi người dùng; xác nhận lại với PO vì US-005 viết cho PER-02.
