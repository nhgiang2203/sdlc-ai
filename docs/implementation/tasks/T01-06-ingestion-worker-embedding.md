# T01-06 — Worker `process_document`: embedding, ghi chunks, trạng thái

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-002 · WP-11 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T01-04](T01-04-document-upload-api.md), [T01-05](T01-05-pdf-extraction-chunking.md) |
| Chặn | [T02-02](T02-02-hybrid-retrieval-rerank.md), [T02-08](T02-08-ingestion-error-handling.md), [T05-03](T05-03-document-removal-api.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Worker Celery nhận job `process_document(document_id)` và xử lý theo thứ tự: tải PDF từ object storage, trích xuất, cắt đoạn (T01-05), embedding bge-m3 qua TEI theo lô 32. Sau đó ghi `docs.pages` + `docs.chunks` và đổi trạng thái `READY` trong **một giao dịch**. Vòng đời cơ bản là `QUEUED → PROCESSING → READY | FAILED`. Có sẵn hook để T02-08 thêm phân loại lỗi và retry.

## 2. Bối cảnh

- SAD §8.2 (phần Worker), §9.1 (vòng đời tài liệu), §4.2 (task `process_document`: hàng đợi `ingest`, concurrency 2, timeout 20 phút), §4.3 (Celery `acks_late`, `visibility_timeout` 1.800 s, `prefetch 1`; pgvector HNSW), §7.2 (`docs.pages`, `docs.chunks`), §11.2 (khoá `lock:doc:{id}` 30 phút, TEI 1 retry sau 200 ms), IF-04.
- NFR-005: PDF ≤ 50 trang phải sẵn sàng trong ≤ 3 phút (p90).
- **Ranh giới với T02-08:** ở S1 mọi lỗi đều thành `FAILED` với `error_reason = 'other'` và **không retry**. T02-08 thay `FailureClassifier` để phân loại mật khẩu/hỏng/scan/quá số trang, thêm 3 lần retry (30 s / 2 phút / 10 phút) cho lỗi tạm thời và ghi audit `DOCUMENT_FAILED`.

## 3. Phạm vi

**Trong phạm vi:** migration `docs.pages`, `docs.chunks` (HNSW, GIN, generated `tsv`); `EmbeddingPort` + `TEIEmbeddingAdapter`; `ChunkRepository`; use case `ProcessDocument`; task Celery + cấu hình worker; khoá idempotent; `FailureClassifier` mặc định và hook `on_failed`; gọi `AnalyticsPort` cho EV-05/EV-06; metric và trace ingest; service `worker` trong Compose dev.

**Ngoài phạm vi:** phân loại lỗi PDF, retry, giới hạn 500 trang, audit `DOCUMENT_FAILED` (T02-08); hiển thị tiến trình "số trang đã xử lý" (OQ-111); `retention_sweep` xếp lại job kẹt (T06-06); `purge_document` (T05-03); truy vấn truy xuất (T02-02); circuit breaker TEI (T05-07).

## 4. Thiết kế chi tiết

### 4.1 Migration `backend/migrations/versions/0103_docs_pages_chunks.py`

```sql
CREATE TABLE docs.pages (
  document_id uuid NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
  page_no int NOT NULL CHECK (page_no >= 1),
  char_count int NOT NULL,
  has_text boolean NOT NULL,
  PRIMARY KEY (document_id, page_no)
);
CREATE TABLE docs.chunks (
  id uuid PRIMARY KEY,
  document_id uuid NOT NULL REFERENCES docs.documents(id) ON DELETE CASCADE,
  ordinal int NOT NULL,
  page_start int NOT NULL, page_end int NOT NULL CHECK (page_end - page_start BETWEEN 0 AND 1),
  text text NOT NULL,
  page_segments jsonb NOT NULL,            -- [{"page": 12, "text": "..."}, {"page": 13, "text": "..."}]
  token_count int NOT NULL,
  embedding vector(1024) NOT NULL,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', f_unaccent(text))) STORED,
  UNIQUE (document_id, ordinal)
);
CREATE INDEX chunks_embedding_hnsw ON docs.chunks USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX chunks_tsv_gin ON docs.chunks USING gin (tsv);
CREATE INDEX chunks_document_idx ON docs.chunks (document_id);
```

### 4.2 Module

| File | Nội dung |
|---|---|
| `backend/cwd/ports/embedding.py` | `EmbeddingPort.embed(texts: Sequence[str], *, purpose: Literal["ingest","query"]) -> list[list[float]]` |
| `backend/cwd/adapters/tei/embedding.py` | `TEIEmbeddingAdapter` (httpx async; `POST {TEI_EMBED_URL}/embed {"inputs": [...], "normalize": true}`; header `Authorization: Bearer <TEI_TOKEN>`; timeout 30 s (`ingest`) / 2 s (`query`); 1 retry sau 200 ms khi gặp lỗi kết nối/5xx; kiểm tra độ dài vector = 1024) |
| `backend/cwd/adapters/postgres/chunk_repository.py` | `replace_for_document(doc_id, pages, chunks, vectors)` (xoá cũ + chèn mới trong giao dịch của caller, dùng `COPY` hoặc `executemany`) |
| `backend/cwd/adapters/valkey/doc_lock.py` | `DocumentLock.acquire(id) -> token \| None` (`SET lock:doc:{id} <token> NX EX 1800`), `release(id, token)` (Lua so khớp token) |
| `backend/cwd/application/ingestion/process_document.py` | `ProcessDocument`, `FailureClassifier`, `FailureDecision` |
| `backend/cwd/entrypoints/worker/tasks.py` | `@celery_app.task(name="cwd.ingestion.process_document", bind=True, acks_late=True, max_retries=0, soft_time_limit=1140, time_limit=1200)` |
| `backend/cwd/entrypoints/worker/celery_app.py` | Bổ sung: `worker_prefetch_multiplier=1`, `task_acks_late=True`, `broker_transport_options={"visibility_timeout": 1800}`, `task_reject_on_worker_lost=True`, route `cwd.ingestion.*` → `ingest` |
| `deploy/compose/dev.yml` | Service `worker`: `celery -A cwd.entrypoints.worker.celery_app worker -Q ingest -c 2`, non-root, `read_only: true`, `tmpfs: /tmp`, `security_opt: no-new-privileges`, giới hạn 2 CPU / 2 GB (đề xuất) |

```python
@dataclass(frozen=True)
class FailureDecision: retry: bool; reason: ErrorReason; countdown_s: int | None = None

class FailureClassifier(Protocol):
    def classify(self, exc: BaseException, attempt: int) -> FailureDecision: ...

class DefaultFailureClassifier:          # S1: mọi lỗi → FAILED/other, không retry. T02-08 thay thế.
    def classify(self, exc, attempt): return FailureDecision(retry=False, reason="other")
```

### 4.3 `ProcessDocument.execute(document_id, attempt)`

1. `token = lock.acquire(id)`. Không lấy được khoá → log `ingest.skipped_locked`, kết thúc (job trùng).
2. `UPDATE docs.documents SET status='PROCESSING' WHERE id=:id AND status IN ('QUEUED','PROCESSING') AND removed_at IS NULL RETURNING filename, uploaded_by, uploaded_at`. Không có dòng (đã `READY`/`FAILED`/`REMOVED`) → giải phóng khoá, kết thúc (idempotent). Trạng thái `PROCESSING` cũ còn sót do worker chết giữa chừng thì được xử lý lại.
3. `object_store.download_to("documents/{id}.pdf", /tmp/{id}.pdf)`.
4. `extracted = extractor.extract(path)`. **Hook T02-08:** `validators: list[ExtractedValidator]` chạy sau bước này (ví dụ quá 500 trang, ≥ 90% trang không chữ → ném lỗi xác định). Ở S1 danh sách rỗng.
5. `drafts = chunk_pages(extracted.pages, counter)`. Không có đoạn nào (PDF không có chữ) → ném `NoExtractableText` (S1 phân loại thành `other`; T02-08 đổi thành `scanned`).
6. Embedding theo lô 32: `embedding.embed([embedding_input(filename, d) for d in batch], purpose="ingest")`.
7. Một giao dịch: `chunk_repo.replace_for_document(...)`, sau đó `UPDATE docs.documents SET status='READY', page_count=:n, unreadable_pages=:u, processed_at=now() WHERE id=:id AND status='PROCESSING' AND removed_at IS NULL`. Cập nhật 0 dòng (tài liệu bị gỡ giữa chừng) → rollback, kết thúc, không phát sự kiện.
8. Sau commit: `analytics.record("document_processing_completed", {document_id, page_count, processing_seconds: processed_at − uploaded_at, unreadable_pages}, user_id=uploaded_by)`.
9. `finally`: xoá file tạm, `lock.release(id, token)`.

**Khi lỗi** (mọi exception ở bước 3–7, kể cả `SoftTimeLimitExceeded`):
`decision = classifier.classify(exc, attempt)`
- `retry=False` → `UPDATE … SET status='FAILED', error_reason=:reason, processed_at=now() WHERE id=:id AND removed_at IS NULL` → gọi các `on_failed` hook (T02-08 gắn audit `DOCUMENT_FAILED`) → EV-06 `{document_id, reason: map(reason)}`.
- `retry=True` (chỉ từ T02-08) → `status='QUEUED'` → `task.retry(countdown=decision.countdown_s)`.
- Log `ingest.failed` gồm `document_id`, `exc_type`, `reason`. Không log nội dung trang.

Bảng ánh xạ `error_reason` → EV-06 `reason`: `password_protected→password`, `corrupted→corrupted`, `scanned→scanned`, `too_many_pages→other`, `other→other` (xem OQ-112).

## 5. Các bước thực hiện

- [ ] Viết migration 0103. Kiểm tra `tsv` generated chạy được với `f_unaccent` (T00-04).
- [ ] Viết `EmbeddingPort`, `TEIEmbeddingAdapter` và test với TEI CPU trong Compose (`BAAI/bge-m3`).
- [ ] Viết `DocumentLock`, `ChunkRepository`.
- [ ] Viết `ProcessDocument`, `DefaultFailureClassifier`, cơ chế `validators`/`on_failed` (danh sách inject qua container DI).
- [ ] Viết task Celery, cấu hình worker và service `worker` trong `dev.yml`.
- [ ] Viết `AnalyticsPort` dạng no-op nếu T01-10 chưa xong (cùng interface `record(name, props, user_id)`).
- [ ] Gắn metric và span (§8). Kiểm tra trace từ `POST /documents` nối sang Worker trên Tempo/Jaeger.
- [ ] Đo trên staging với `contract_vi_50p.pdf` × 20 lần, ghi p50/p90 vào `docs/implementation/reports/s1-ingest-latency.md` (đề xuất).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US002-2 (phía server):** PDF hợp lệ 50 trang chuyển `QUEUED → PROCESSING → READY` với p90 ≤ 3 phút tính từ `uploaded_at`, đo trên staging với TEI CPU. Việc giao diện cập nhật mà không cần tải lại trang xác nhận ở T01-09.
- [ ] **AC-US002-3 (phần S1):** sau `READY`, `docs.chunks` có đủ đoạn của tài liệu với `page_start/page_end` đúng trang nguồn. Câu truy vấn lai mẫu (SAD §7.2) với một cụm từ chỉ có trong tài liệu trả về đoạn của tài liệu đó ở top 5. Phần "câu trả lời trích dẫn đúng tài liệu" kiểm thử E2E ở T02-05.
- [ ] Không có trạng thái nửa vời: giả lập lỗi khi đang ghi chunk → không còn dòng nào trong `docs.chunks`, tài liệu thành `FAILED/other`.
- [ ] Job chạy hai lần (gửi trùng) → chỉ một lần xử lý; số đoạn không bị nhân đôi.
- [ ] Tài liệu bị gỡ (`removed_at` có giá trị) giữa chừng → không chuyển sang `READY`, không còn chunk.
- [ ] Tài liệu có trang ảnh → `READY` với `unreadable_pages` = số trang `has_text = false` (dữ liệu cho AC-US003-5).
- [ ] EV-05/EV-06 được ghi (hoặc gọi no-op) đúng một lần mỗi tài liệu.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `ProcessDocument` với fake port: luồng thành công; khoá bận → bỏ qua; trạng thái `READY` → no-op; embedding lỗi → `FAILED/other`; bị gỡ trước khi commit → rollback; classifier trả `retry=True` → `QUEUED` + gọi retry |
| Integration | PostgreSQL + SeaweedFS + Valkey + `FakeEmbedding` (vector tất định từ hash): `normal_10p.pdf` → `READY`, `pages`=10, đúng số chunk; `mixed_scan_12p.pdf` → `unreadable_pages = 2`; `encrypted.pdf` → `FAILED/other` (S1) |
| Integration | TEI thật (job CI có nhãn `tei`): lô 32 đoạn trả 32 vector 1024 chiều, đã chuẩn hoá (chuẩn ≈ 1) |
| Integration | Celery eager tắt, worker thật trong Testcontainers: kill worker giữa chừng → job được giao lại (`acks_late`) → `READY` |
| E2E (S1) | Playwright: đăng nhập → tải `normal_10p.pdf` → thấy "Sẵn sàng" (dùng chung với T01-09) |
| Hiệu năng | Đo 20 lần PDF 50 trang trên staging (§5) |

## 8. Analytics / observability

- EV-05 `document_processing_completed`, EV-06 `document_processing_failed` ghi phía server qua `AnalyticsPort` (triển khai ở T01-10).
- Metric: `cwd_ingest_seconds` (histogram, nhãn `pages_bucket` = `1-10|11-50|51-200|201-500`), `cwd_ingest_failures_total{reason}`, `cwd_queue_depth{queue="ingest"}` (exporter đọc độ dài list Valkey), `cwd_embed_batch_seconds`.
- Span `ingest.process_document` → `s3.get`, `ingest.extract`, `ingest.chunk`, `embed.batch` (× n), `db.persist`. Thuộc tính gồm `document_id`, `page_count`, `chunk_count`, **không có văn bản**.

## 9. Tham chiếu

SAD §4.2 (chunking, bảng tác vụ bất đồng bộ), §4.3, §5 (INV-01), §7.2, §7.3, §8.2, §9.1, §10.4 IF-04/IF-06, §11.2, §11.3; ADR-003, ADR-004, ADR-010; USER_STORIES US-002; NFR-005.

## 10. Giả định và câu hỏi mở

- Giả định: TEI CPU trên staging đủ nhanh cho p90 ≤ 3 phút với 50 trang (~100–150 đoạn). Nếu không đạt thì tăng số replica TEI hoặc dùng GPU (OQ-034).
- Giả định: `processing_seconds` của EV-05 tính từ `uploaded_at`, tức là gồm cả thời gian chờ trong hàng đợi, khớp với cách người dùng cảm nhận NFR-005 (đề xuất).
- **OQ-111:** SAD §9.1 ghi `PROCESSING` hiển thị "tiến trình (số trang đã xử lý)" nhưng schema và API không có trường này. Đề xuất S1 chỉ hiển thị "Đang xử lý". Nếu cần tiến trình thì thêm `processed_pages` vào `docs.documents` và cập nhật mỗi lô.
- **OQ-112:** Danh mục EV-06 `reason` (password / corrupted / scanned / other) dùng từ khác `error_reason` của API (`password_protected`, `too_many_pages`). Đề xuất thêm `too_many_pages` vào EV-06 hoặc chốt bảng ánh xạ §4.3.
