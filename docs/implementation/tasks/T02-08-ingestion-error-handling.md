# T02-08 — Phân loại lỗi PDF, chính sách retry, 413/415

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-004 · WP-23 |
| Loại | BE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-06](T01-06-ingestion-worker-embedding.md) |
| Chặn | [T02-09](T02-09-fe-document-errors.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hoàn thiện xử lý lỗi của pipeline nạp tài liệu: phân loại `error_reason` (`password_protected`, `corrupted`, `scanned`, `too_many_pages`, `other`), tách lỗi xác định (không retry) khỏi lỗi tạm thời (3 retry 30 s / 2 phút / 10 phút), ghi audit `DOCUMENT_FAILED` và EV-06; chuẩn hoá phản hồi 413/415 của API và Nginx; thêm `DELETE /api/v1/documents/{id}` tối thiểu cho tài liệu `FAILED` ("Xoá khỏi danh sách").

## 2. Bối cảnh

- US-004 kéo lên S2 vì worker xử lý PDF đã viết ở US-002 (IMPLEMENTATION_PLAN §2.3).
- [T01-06](T01-06-ingestion-worker-embedding.md) có task `process_document` (pypdfium2 → chunk → embed → ghi một giao dịch, khoá `lock:doc:{id}`); [T01-04](T01-04-document-upload-api.md) có `POST /documents` kiểm magic bytes, sha256.
- SAD §4.2 (tác vụ C-03), §9.1 (vòng đời tài liệu: `PROCESSING → QUEUED` khi còn lượt retry, `FAILED → REMOVED` khi xoá khỏi danh sách), §11.1 (tệp độc hại, Worker non-root, timeout 20 phút).

## 3. Phạm vi

**Trong phạm vi:**
- Hàm miền phân loại lỗi và phát hiện scan.
- Chính sách retry Celery cho `process_document`; chuyển trạng thái đúng §9.1.
- Audit `DOCUMENT_FAILED`, EV-06 `document_processing_failed`, metric `cwd_ingest_failures_total{reason}`.
- 413 `FILE_TOO_LARGE`, 415 `UNSUPPORTED_MEDIA_TYPE` dạng problem+json ở API; Nginx `client_max_body_size 51m` + trang lỗi 413 dạng JSON.
- `DELETE /api/v1/documents/{id}` chỉ cho tài liệu `FAILED` (bản tối thiểu S2).

**Ngoài phạm vi:**
- Gỡ tài liệu `READY` đầy đủ (xoá pages/chunks, 409 `ALREADY_REMOVED` khi hai người gỡ, `purge_document`, EV-07) → [T05-03](T05-03-document-removal-api.md).
- Thông báo phía client, hiển thị lý do lỗi, nút "Xoá khỏi danh sách" → [T02-09](T02-09-fe-document-errors.md).
- Quét virus ClamAV (OQ-033) → nếu có, bổ sung S5.
- Xếp lại job kẹt `QUEUED` > 30 phút → `retention_sweep` [T06-06](T06-06-conversation-history-retention.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/documents/errors.py` | `ErrorReason` (StrEnum), `DeterministicIngestError`, `TransientIngestError` |
| `backend/cwd/domain/documents/scan_detection.py` | `is_scanned(pages, threshold=0.9)`, `page_has_text(char_count)` |
| `backend/cwd/adapters/pdf/pypdfium_extractor.py` | Bổ sung ánh xạ lỗi pypdfium2 → `ErrorReason` |
| `backend/cwd/application/ingestion/process_document.py` | Phân nhánh lỗi, chuyển trạng thái, audit, EV-06 |
| `backend/cwd/entrypoints/worker/tasks.py` | Chính sách retry `process_document` |
| `backend/cwd/application/ingestion/remove_failed_document.py` | `RemoveFailedDocument` (S2) |
| `backend/cwd/entrypoints/api/routers/documents.py` | 413/415, `DELETE /documents/{id}` |
| `deploy/nginx/conf.d/cwd.conf` | `client_max_body_size 51m;` + `error_page 413` JSON |

### 4.2 Phân loại lỗi

| `error_reason` | Phát hiện | Loại | Văn bản hiển thị (T02-09) |
|---|---|---|---|
| `password_protected` | pypdfium2 `PdfiumError` mã `FPDF_ERR_PASSWORD` (4) hoặc `FPDF_ERR_SECURITY` (6) | Xác định | "File có mật khẩu. Hãy gỡ mật khẩu rồi tải lại." |
| `corrupted` | `PdfiumError` mã `FPDF_ERR_FILE` (2), `FPDF_ERR_FORMAT` (3), hoặc mã không rõ khi mở; `page_count == 0` | Xác định | "File bị hỏng, không mở được. Hãy xuất lại PDF rồi tải lại." |
| `too_many_pages` | `page_count > CWD_MAX_PAGES` (500, OQ-004) — kiểm **trước** khi trích văn bản | Xác định | "File vượt quá 500 trang." |
| `scanned` | `is_scanned`: ≥ 90% trang có `has_text = false` | Xác định | "PDF dạng ảnh scan — chưa hỗ trợ. Hãy dùng bản PDF có chữ chọn được." |
| `other` | Hết lượt retry lỗi tạm thời; hoặc vượt timeout 20 phút (đề xuất) | — | "Lỗi xử lý, vui lòng thử tải lại." |

- `page_has_text`: số ký tự không phải khoảng trắng của trang ≥ 20 (đề xuất, hiệu chỉnh bằng bộ tài liệu mẫu DEP-002). Ngưỡng 0,9 và 20 là cấu hình (`CWD_SCAN_RATIO`, `CWD_MIN_PAGE_CHARS`).
- Tài liệu có < 90% trang không có chữ → vẫn `READY`, `unreadable_pages` = số trang không có chữ (EC-10, đã có ở T01-06).
- Mã lỗi pypdfium2 cần xác nhận với phiên bản đã khoá (thuộc tính `err_code` của `PdfiumError` trong pypdfium2 4.x) — test với bộ file lỗi mẫu là nguồn sự thật.

### 4.3 Lỗi tạm thời và retry

| Nguồn | Ví dụ | Loại |
|---|---|---|
| TEI `/embed` | timeout 30 s, 5xx, kết nối | Tạm thời |
| Object storage `GetObject` | 5xx, timeout | Tạm thời (sau 3 retry nội bộ S3 SDK) |
| PostgreSQL | `OperationalError`, deadlock | Tạm thời |
| Lỗi lập trình (`KeyError`, …) | — | Không retry, `FAILED other`, log `error` (đề xuất) |

```python
@celery_app.task(bind=True, queue="ingest", acks_late=True, max_retries=3,
                 soft_time_limit=19 * 60, time_limit=20 * 60)
def process_document(self, document_id: str) -> None:
    try:
        ProcessDocument(...).execute(UUID(document_id))
    except TransientIngestError as exc:
        if self.request.retries >= self.max_retries:
            fail_document(document_id, ErrorReason.OTHER)          # FAILED + audit + EV-06
            return
        set_status(document_id, "QUEUED")                          # SAD §9.1 PROCESSING → QUEUED
        raise self.retry(exc=exc, countdown=RETRY_BACKOFF_S[self.request.retries])  # [30, 120, 600]
    except DeterministicIngestError as exc:
        fail_document(document_id, exc.reason)                     # không retry
    except SoftTimeLimitExceeded:
        fail_document(document_id, ErrorReason.OTHER)              # (đề xuất) không retry khi quá 20 phút
```

- `fail_document` trong **một giao dịch**: `UPDATE docs.documents SET status='FAILED', error_reason=:r WHERE id=:id AND status IN ('QUEUED','PROCESSING')`; xoá pages/chunks dở dang nếu có (thực tế không có vì ghi một giao dịch); `INSERT ops.audit_log (actor_id = uploaded_by, action='DOCUMENT_FAILED', document_id, document_filename)`; EV-06.
- Tài liệu `FAILED` không bao giờ có chunk → không truy xuất được (INV-01).
- Khoá `lock:doc:{id}` giữ qua retry? Không — nhả khi task kết thúc mỗi lần; lần retry lấy lại (tránh khoá treo 30 phút).

### 4.4 413 / 415

| Lớp | Hành vi |
|---|---|
| Nginx | `client_max_body_size 51m;` trên `location /api/v1/documents`; `error_page 413 = @too_large;` với `location @too_large { default_type application/problem+json; return 413 '{"type":"about:blank","title":"File vượt quá 50 MB","status":413,"code":"FILE_TOO_LARGE","limit_bytes":52428800}'; }` (đề xuất — để FE đọc được JSON thay vì trang HTML) |
| API | Đếm byte khi stream multipart; vượt 50 MiB (52.428.800 byte, `CWD_MAX_UPLOAD_BYTES`) → huỷ, xoá object tạm, 413 `FILE_TOO_LARGE` `{limit_bytes}` |
| API | 5 byte đầu ≠ `%PDF-` hoặc `Content-Type` phần file không phải `application/pdf` → 415 `UNSUPPORTED_MEDIA_TYPE` `{detail: "Chỉ hỗ trợ file PDF"}` |

### 4.5 `DELETE /api/v1/documents/{id}` (tối thiểu S2)

| Trường hợp | Phản hồi |
|---|---|
| Không tồn tại | 404 `DOCUMENT_NOT_FOUND` |
| `status = FAILED` | Giao dịch: `SELECT … FOR UPDATE` → `status = REMOVED`, `removed_at = now()`, `removed_by = user`; audit `DOCUMENT_REMOVED`; commit → xoá object `documents/{id}.pdf` best-effort (lỗi chỉ log; T05-03 thay bằng `purge_document`) → **204** |
| `status = REMOVED` | 409 `ALREADY_REMOVED` |
| `status ∈ {QUEUED, PROCESSING, READY}` | 409 `DOCUMENT_NOT_REMOVABLE` (đề xuất, tạm thời S2 — T05-03 mở rộng cho `READY`) |

- Mọi người dùng được cấp quyền đều xoá được (BR-003, như gỡ tài liệu); cần CSRF.
- `GET /documents` đã loại `REMOVED` (T01-07) → tài liệu biến mất khỏi danh sách.

## 5. Các bước thực hiện

- [ ] Thu thập bộ file lỗi mẫu từ QA (DEP-002): có mật khẩu (user password, owner password), hỏng (cắt đôi, đổi đuôi .docx→.pdf), scan toàn bộ, scan một phần, 501 trang, 51 MB.
- [ ] Viết `errors.py`, `scan_detection.py` + unit test.
- [ ] Ánh xạ lỗi pypdfium2 trong extractor; viết test với bộ file mẫu.
- [ ] Cập nhật `ProcessDocument` + task Celery theo §4.3; `fail_document` một giao dịch.
- [ ] Ghi EV-06 qua `AnalyticsRecorder` (T01-10); metric `cwd_ingest_failures_total{reason}`.
- [ ] Chuẩn hoá 413/415 ở API; cấu hình Nginx (phối hợp DevOps, file của T00-07).
- [ ] Viết `RemoveFailedDocument` + route `DELETE`; thêm vào ma trận phân quyền.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US004-3:** PDF có mật khẩu / hỏng / scan → `status = FAILED`, `error_reason` tương ứng `password_protected` / `corrupted` / `scanned`; tài liệu không có chunk và không bao giờ xuất hiện trong truy xuất (test tích hợp với bộ file mẫu).
- [ ] **AC-US004-5:** TEI không phản hồi (tắt container trong test) → 3 lần retry với độ trễ 30 s / 2 phút / 10 phút (kiểm `countdown`), trạng thái `QUEUED` giữa các lần, sau lần thứ 3 → `FAILED`, `error_reason = other`; lỗi xác định thất bại ngay ở lần đầu, không có retry (kiểm `self.retry` không được gọi).
- [ ] PDF 501 trang → `FAILED too_many_pages` trước khi trích văn bản (dữ liệu cho AC-US004-2 ở T02-09).
- [ ] Upload 51 MB qua Nginx → 413 `application/problem+json` có `code = FILE_TOO_LARGE`; tệp `.docx` đổi đuôi `.pdf` → 415.
- [ ] `DELETE` tài liệu `FAILED` → 204, `GET /documents` không còn tài liệu, audit có `DOCUMENT_REMOVED` (phục vụ AC-US004-4 ở T02-09); `DELETE` tài liệu `READY` → 409 trong S2.
- [ ] Audit `DOCUMENT_FAILED` và EV-06 ghi đúng một lần cho mỗi tài liệu thất bại (kể cả sau retry).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `is_scanned` ở 0,89 / 0,90 / 1,0; `page_has_text` ngưỡng 20; ánh xạ mã lỗi pdfium |
| Integration (worker + Testcontainers) | Từng file trong bộ lỗi mẫu → `error_reason` đúng; scan một phần → `READY` + `unreadable_pages` |
| Retry | Celery `task_always_eager=False` với worker test; TEI giả trả 503 → 3 retry; TEI hồi phục ở lần 2 → `READY` |
| API | 413 (API và Nginx), 415; `DELETE` 204 / 404 / 409; thiếu CSRF → 403 |
| Bảo mật | PDF có JavaScript nhúng → không thực thi, xử lý như PDF thường |

## 8. Analytics / observability

- EV-06 `document_processing_failed` `{document_id, reason}` — `reason` theo PRD (`password | corrupted | scanned | other`): ánh xạ `password_protected → password`; `too_many_pages` chưa có trong PRD (xem §10).
- Audit `DOCUMENT_FAILED`, `DOCUMENT_REMOVED` trong `ops.audit_log` (INV-05).
- Metric `cwd_ingest_failures_total{reason}`, `cwd_ingest_retries_total`; cảnh báo "Ingest thất bại > 20%/giờ" cấu hình ở T06-04.
- Log: `document_id`, `reason`, `retry`, không ghi nội dung trang.

## 9. Tham chiếu

- [USER_STORIES.md — US-004](../../requirements/USER_STORIES.md)
- [SAD.md](../../requirements/SAD.md) §4.2 (tác vụ C-03), §7.2 (`docs.documents`, `ops.audit_log`), §8.2, §9.1, §10.2, §11.1, ADR-012
- [PRD.md](../../requirements/PRD.md) §5.2 EC-08, EC-09, EC-10; §6.2 EV-06
- [mock-data.js](../../design/UI_UX_design/assets/mock-data.js) (`errorText`)

## 10. Giả định và câu hỏi mở

- Giả định giới hạn 50 MB / 500 trang (OQ-004) — cấu hình được.
- **OQ-T0208-1:** PRD EV-06 `reason` dùng `password` (không phải `password_protected`) và thiếu `too_many_pages`. Đề xuất cập nhật PRD về cùng tập giá trị với `error_reason`.
- **OQ-T0208-2:** Timeout 20 phút có retry không? Đề xuất không (tài liệu quá nặng sẽ lặp lại timeout), báo `other`.
- **OQ-T0208-3:** Mã lỗi `DOCUMENT_NOT_REMOVABLE` cho S2 là tạm; T05-03 bỏ khi hỗ trợ gỡ `READY`. Có cho xoá tài liệu đang `QUEUED` bị kẹt không? Đề xuất không ở MVP.
- **OQ-T0208-4:** Nginx 413 mặc định trả HTML — đề xuất bổ sung `error_page` JSON vào SAD §11.1 / cấu hình T00-07.
