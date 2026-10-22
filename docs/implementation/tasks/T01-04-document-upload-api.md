# T01-04 — API tải PDF lên: kiểm tra, sha256, trùng lặp, object store, enqueue

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-002 · WP-11 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T00-04](T00-04-db-baseline-migration.md), [T01-02](T01-02-csrf-rbac-ratelimit-me.md) |
| Chặn | [T01-06](T01-06-ingestion-worker-embedding.md), [T01-07](T01-07-document-list-api.md), [T04-01](T04-01-document-file-range-api.md), [T05-05](T05-05-audit-log-api.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp `POST /api/v1/documents`. Endpoint nhận một file PDF qua multipart, kiểm tra magic bytes và kích thước, tính sha256 trong lúc stream, cảnh báo trùng lặp (409), lưu file vào object storage, tạo bản ghi `QUEUED` kèm nhật ký `DOCUMENT_UPLOADED`, rồi xếp hàng job `process_document`.

## 2. Bối cảnh

- SAD §8.2 (trình tự tải lên), §10.2 (hợp đồng endpoint), §7.2 (`docs.documents`, `ops.audit_log`), INV-06, IF-06; §11.1 (tệp tải lên độc hại), §11.2 (30 lượt tải lên/giờ, S3 retry 3 lần).
- API chỉ lưu file và xếp hàng. Mọi việc nặng làm ở Worker (SAD §4.2). Worker là T01-06.
- T00-04 chỉ tạo schema, extension và `access.users`. **Bảng `docs.documents` và `ops.audit_log` do task này tạo.**

## 3. Phạm vi

**Trong phạm vi:** migration `docs.documents` (trừ chỉ mục trigram, làm ở T01-07) và `ops.audit_log`; domain `Document`, `DocumentStatus`; `ObjectStorePort` + `S3ObjectStore`; `JobQueuePort` + `CeleryJobQueue` (khung `celery_app` dùng chung); `DocumentRepository.add/find_active_by_sha256`; `AuditLogRepository.append`; use case `UploadDocument`; router `POST /api/v1/documents`; rate limit `UPLOAD_POLICY`; sự kiện client EV-03 và EV-04 `duplicate_cancelled` (hợp đồng, phát ở T01-08).

**Ngoài phạm vi:** Nginx `client_max_body_size 51m`, thông điệp lỗi 413/415 hoàn chỉnh theo US-004 và kiểm tra số trang (T02-08); worker xử lý (T01-06); `GET` danh sách/chi tiết (T01-07); `GET /file` (T04-01); quyền CSDL chỉ `INSERT` cho `audit_log` và API đọc nhật ký (T05-05); quét virus (OQ-033).

## 4. Thiết kế chi tiết

### 4.1 Migration `backend/migrations/versions/0102_docs_documents_audit.py`

```sql
CREATE TYPE docs.document_status AS ENUM ('QUEUED','PROCESSING','READY','FAILED','REMOVED');
CREATE TABLE docs.documents (
  id               uuid PRIMARY KEY,                 -- UUID v7 sinh ở ứng dụng
  filename         text NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  sha256           char(64) NOT NULL,
  size_bytes       bigint NOT NULL CHECK (size_bytes > 0),
  page_count       int,                              -- NULL cho tới khi Worker xử lý
  status           docs.document_status NOT NULL DEFAULT 'QUEUED',
  error_reason     text CHECK (error_reason IN ('password_protected','corrupted','scanned','too_many_pages','other')),
  unreadable_pages int NOT NULL DEFAULT 0,
  uploaded_by      uuid NOT NULL REFERENCES access.users(id),
  uploaded_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,                      -- (đề xuất) thời điểm READY/FAILED, cho EV-05
  removed_at       timestamptz,
  removed_by       uuid REFERENCES access.users(id)
);
CREATE INDEX documents_status_uploaded_idx ON docs.documents (status, uploaded_at DESC);
CREATE INDEX documents_sha256_active_idx  ON docs.documents (sha256) WHERE removed_at IS NULL; -- KHÔNG UNIQUE (AC-US002-4)
CREATE INDEX documents_uploaded_idx       ON docs.documents (uploaded_at DESC, id DESC);      -- keyset cho T01-07 (đề xuất)

CREATE TABLE ops.audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('DOCUMENT_UPLOADED','DOCUMENT_REMOVED','DOCUMENT_FAILED')),
  document_id uuid NOT NULL,
  document_filename text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_at_idx ON ops.audit_log (at DESC);
```

### 4.2 Module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/documents/document.py` | `DocumentStatus` (StrEnum), `ErrorReason`, `Document` (dataclass); `sanitize_filename(raw) -> str` |
| `backend/cwd/domain/documents/limits.py` | `MAX_FILE_BYTES = 52_428_800`, `PDF_MAGIC = b"%PDF-"`, `MAX_PAGES = 500` (T02-08 dùng) |
| `backend/cwd/ports/object_store.py` | `ObjectStorePort` |
| `backend/cwd/ports/job_queue.py` | `JobQueuePort` |
| `backend/cwd/adapters/s3/object_store.py` | `S3ObjectStore` (boto3 + `botocore.Config(retries={"max_attempts": 3, "mode": "standard"}, connect_timeout=5, read_timeout=30)`) |
| `backend/cwd/adapters/celery/job_queue.py` | `CeleryJobQueue` → `celery_app.send_task("cwd.ingestion.process_document", args=[str(id)], queue="ingest")` |
| `backend/cwd/entrypoints/worker/celery_app.py` | Khởi tạo `Celery("cwd")`, broker `VALKEY_URL/1`, khai báo queue `ingest`, `maintenance` (T01-06 bổ sung cấu hình worker) |
| `backend/cwd/adapters/postgres/document_repository.py` | `add`, `find_active_by_sha256`, `get` |
| `backend/cwd/adapters/postgres/audit_repository.py` | `append(entry)` |
| `backend/cwd/application/ingestion/upload_document.py` | `UploadDocument` |
| `backend/cwd/entrypoints/api/routers/documents.py` | `POST /api/v1/documents` |
| `backend/cwd/entrypoints/api/schemas/documents.py` | `DocumentOut` (dùng chung với T01-07) |

```python
class ObjectStorePort(Protocol):
    async def put(self, key: str, file: BinaryIO, size: int, content_type: str) -> None: ...
    async def download_to(self, key: str, dest: Path) -> None: ...          # T01-06
    async def get_range(self, key: str, start: int, end: int | None) -> AsyncIterator[bytes]: ...  # T04-01
    async def delete(self, key: str) -> None: ...                           # T05-03

class JobQueuePort(Protocol):
    def enqueue_process_document(self, document_id: UUID) -> None: ...
```

Khoá object: `documents/{document_id}.pdf`. Bucket `CWD_S3_BUCKET`, `ServerSideEncryption="AES256"` (hoặc theo cấu hình của IT).

### 4.3 Endpoint `POST /api/v1/documents`

Request: `multipart/form-data`, phần `file` (bắt buộc, một file), `confirm_duplicate` (`true|false`, mặc định `false`). Dependency: `require_roles("user")`, `rate_limit(UPLOAD_POLICY)` (30/giờ).

Xử lý (`UploadDocument.execute(stream, filename, confirm_duplicate, actor)`):

1. Đọc stream theo khối 1 MiB vào `SpooledTemporaryFile(max_size=1 MiB)`. Cùng lúc đó cập nhật `hashlib.sha256` và đếm byte. Vượt `MAX_FILE_BYTES` → dừng đọc, 413 `FILE_TOO_LARGE`.
2. 5 byte đầu ≠ `%PDF-` → 415 `UNSUPPORTED_MEDIA_TYPE`. Không tin `Content-Type` của phần file. File rỗng → 400 `VALIDATION_ERROR`.
3. `filename = sanitize_filename(raw)`: bỏ phần đường dẫn (`/`, `\`), chuẩn hoá NFC, bỏ ký tự điều khiển, cắt 255 ký tự, giữ đuôi `.pdf`. Rỗng → `"tai-lieu.pdf"`.
4. `find_active_by_sha256(h)`. Có kết quả và `confirm_duplicate = false` → 409 `DUPLICATE_DOCUMENT`, body problem có thêm `existing_document_id`, `existing_filename`, `existing_uploaded_at` (2 trường sau là đề xuất, phục vụ hộp thoại T01-08).
5. `id = uuid7()`; `ObjectStorePort.put("documents/{id}.pdf", …)`.
6. Giao dịch: `INSERT docs.documents (… status='QUEUED')` + `INSERT ops.audit_log (DOCUMENT_UPLOADED, actor, id, filename)`. Giao dịch lỗi → `delete` object (bù trừ, lỗi thì chỉ log) → 500.
7. Sau commit: `enqueue_process_document(id)`. Lỗi enqueue → **vẫn trả 201** (tài liệu ở `QUEUED`), log `error` `ingest.enqueue_failed`. `retention_sweep` (T06-06) sẽ xếp lại job kẹt `QUEUED` > 30 phút (SAD §4.3).
8. Trả 201 `DocumentOut` + header `Location: /api/v1/documents/{id}`.

```json
201 { "id": "0193…", "filename": "HopDong_PhuHung_v2.pdf", "size_bytes": 3355443, "page_count": null,
      "status": "QUEUED", "error_reason": null, "unreadable_pages": 0,
      "uploaded_by": { "id": "0192…", "display_name": "Trần Quốc Bảo" }, "uploaded_at": "2026-11-12T02:10:00Z" }
409 { "type": "…/duplicate-document", "title": "Tài liệu này đã có trong kho", "status": 409, "code": "DUPLICATE_DOCUMENT",
      "existing_document_id": "0191…", "existing_filename": "HopDong_PhuHung_v2.pdf", "existing_uploaded_at": "2026-10-14T02:12:00Z", "request_id": "…" }
```

| Mã | Khi nào |
|---|---|
| 400 `VALIDATION_ERROR` | Thiếu phần `file`, nhiều hơn một file, file rỗng, `confirm_duplicate` sai kiểu |
| 409 `DUPLICATE_DOCUMENT` | INV-06 |
| 413 `FILE_TOO_LARGE` | > 50 MB (lớp API; lớp Nginx do T02-08 làm) |
| 415 `UNSUPPORTED_MEDIA_TYPE` | Magic bytes không phải `%PDF-` |
| 429 `RATE_LIMITED` | > 30 lượt/giờ |
| 503 `STORAGE_UNAVAILABLE` (đề xuất) | Object storage lỗi sau 3 lần thử |

## 5. Các bước thực hiện

- [ ] Viết migration 0102 và chạy `alembic upgrade head` trên Testcontainers.
- [ ] Viết domain `document.py`, `limits.py`, `sanitize_filename` và unit test.
- [ ] Viết `ObjectStorePort`, `S3ObjectStore` (thêm `boto3` vào `pyproject.toml`), test với SeaweedFS trong Compose.
- [ ] Viết `celery_app.py` (khung) và `CeleryJobQueue`. Truyền trace context qua header Celery (OTel instrumentation).
- [ ] Viết repository document và audit.
- [ ] Viết `UploadDocument` (bù trừ object khi giao dịch lỗi) và router với `rate_limit(UPLOAD_POLICY)`.
- [ ] Thêm handler MSW `POST /api/v1/documents` (201/409/413/415/429) cho FE.
- [ ] Cập nhật OpenAPI.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US002-6:** sau một lần tải lên thành công, `ops.audit_log` có đúng một bản ghi `DOCUMENT_UPLOADED` với `actor_id`, `document_id`, `document_filename`, `at`. Màn hình nhật ký làm ở T05-06.
- [ ] INV-06: tải lại file cùng sha256 khi bản cũ chưa gỡ → 409 kèm `existing_document_id`; gửi lại với `confirm_duplicate=true` → 201, có 2 bản ghi. Bản cũ đã gỡ thì không cảnh báo. Hộp thoại AC-US002-4 làm ở T01-08.
- [ ] File > 50 MB → 413, file không phải PDF (đổi đuôi `.pdf`) → 415; không có object hay bản ghi nào được tạo.
- [ ] 201 trả về trong ≤ 2 s với file 10 MB trên staging (đề xuất). Object tồn tại ở `documents/{id}.pdf`. Job có trong hàng đợi `ingest`.
- [ ] Không log tên file hay nội dung. Log chỉ có `document_id`, `size_bytes`.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `sanitize_filename`: `../../etc/a.pdf` → `a.pdf`; `C:\x\Báo giá.pdf` → `Báo giá.pdf` (NFC); 300 ký tự → 255 và giữ `.pdf`; ký tự `\x00` bị bỏ |
| Unit | `UploadDocument` với fake port: trùng + không xác nhận → `DuplicateDocument`; DB lỗi → gọi `delete` object; enqueue lỗi → vẫn trả document |
| Integration | PostgreSQL + SeaweedFS + Valkey: PDF mẫu 1 trang → 201, kiểm tra DB/object/queue; 50 MB + 1 byte → 413 và không còn file tạm; file `.pdf` chứa PNG → 415; 2 request trùng đồng thời không xác nhận → ít nhất 1 nhận 409 hoặc cả hai 201 (cho phép, vì không UNIQUE; ghi nhận hành vi) |
| Integration | 31 lượt trong một giờ → 429 + `Retry-After` |
| Bảo mật | Thiếu CSRF → 403; ẩn danh → 401; tên file chứa `<script>` được lưu nguyên văn dạng text (FE escape) |

## 8. Analytics / observability

- EV-03 `document_upload_started` (`document_id`, `file_size_mb`, `batch_size`) và EV-04 `document_upload_rejected` (`reason=duplicate_cancelled`) do **client** phát (T01-08, T01-10). EV-03 phát khi nhận 201 vì lúc đó mới có `document_id` (đề xuất, xem OQ-107).
- Metric: `cwd_upload_bytes` (histogram), `cwd_upload_total{outcome=created|duplicate|too_large|unsupported|rate_limited}`.
- Span `ingest.upload` (`size_bytes`, `duplicate`), con: `s3.put`, `db.insert`, `queue.enqueue`.

## 9. Tham chiếu

SAD §4.2 (`ingestion`), §4.3 (object storage), §7.2, INV-06, §8.2, §10.1 (idempotency bằng sha256), §10.2, IF-06, §11.1, §11.2; USER_STORIES US-002; PRD EC-11.

## 10. Giả định và câu hỏi mở

- Giả định: dùng `boto3` làm S3 client. SAD §6.2 chưa liệt kê, cần thêm vào danh sách giấy phép (Apache-2.0).
- Giả định: `uuid7()` lấy từ thư viện `uuid6` hoặc `uuid-utils` vì Python 3.12 chưa có sẵn (đề xuất).
- Cột `processed_at` và chỉ mục `(uploaded_at DESC, id DESC)` là đề xuất, chưa có trong SAD §7.2.
- **OQ-107:** EV-03 được định nghĩa là "bắt đầu tải một file lên" nhưng có `document_id`, mà id chỉ có sau 201. Phát EV-03 khi nhận 201 (đề xuất), hay đổi danh mục để cho phép `document_id = null` lúc bắt đầu?
- **OQ-108:** Cảnh báo trùng chỉ dựa trên nội dung (sha256), không dựa trên tên file. PRD EC-11 ghi "cùng tên, cùng nội dung". Cần PO xác nhận rằng cùng tên khác nội dung thì không cảnh báo.
