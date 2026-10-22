# T01-07 — API danh sách / chi tiết tài liệu, lọc bỏ dấu

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-003 · WP-12 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-04](T01-04-document-upload-api.md) |
| Chặn | — theo README. Thực tế là hợp đồng cho [T01-09](T01-09-fe-document-sidebar.md) và [T04-04](T04-04-fe-scope-selection.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp `GET /api/v1/documents` (phân trang cursor, lọc theo tên không phân biệt hoa thường và dấu, lọc theo trạng thái, mới nhất trước) và `GET /api/v1/documents/{id}` (kèm `unreadable_pages`). Đây là nguồn dữ liệu cho cột kho tài liệu và cho polling trạng thái.

## 2. Bối cảnh

- SAD §10.2 (hợp đồng, schema `Document`), §10.1 (phân trang `page_size` ≤ 100, mặc định 50, `cursor` opaque, `next_cursor`), §7.2 (btree `(status, uploaded_at DESC)`, trigram GIN trên `f_unaccent(lower(filename))`), §9.1 (`REMOVED` không hiển thị trong danh sách), §7.1 (truy vấn chéo module chỉ qua application service).
- SPA poll 5 s khi còn tài liệu `QUEUED`/`PROCESSING` (ADR-011). Endpoint phải rẻ và **không gia hạn phiên** khi có `X-CWD-Background: 1` (T01-01).

## 3. Phạm vi

**Trong phạm vi:** migration chỉ mục trigram; `DocumentRepository.list/get`; `UserDirectory.display_names(ids)` (module `access`); use case `ListDocuments`, `GetDocument`; 2 route `GET`; mã hoá/giải mã cursor; handler MSW và fixture từ `mock-data.js`.

**Ngoài phạm vi:** `DELETE /documents/{id}` (T05-03, và "Xoá khỏi danh sách" cho tài liệu lỗi ở T02-09); `GET /documents/{id}/file` (T04-01); hiển thị (T01-09).

## 4. Thiết kế chi tiết

### 4.1 Migration `backend/migrations/versions/0104_docs_filename_trgm.py`

```sql
CREATE INDEX documents_filename_trgm ON docs.documents
  USING gin (f_unaccent(lower(filename)) gin_trgm_ops) WHERE removed_at IS NULL;
```

`lower` chạy trước `f_unaccent`: chữ "Đ" thành "đ" rồi thành "d" (từ điển `unaccent` mặc định có ánh xạ `đ → d`).

### 4.2 Module

| File | Nội dung |
|---|---|
| `backend/cwd/application/ingestion/list_documents.py` | `ListDocuments(q, statuses, cursor, page_size)` → `DocumentPage(items, next_cursor)`; `GetDocument(id)` |
| `backend/cwd/adapters/postgres/document_repository.py` | thêm `list(...)`, `get_active(id)` |
| `backend/cwd/application/access/user_directory.py` + `adapters/postgres/user_repository.py` | `display_names(ids: set[UUID]) -> dict[UUID, str]` (một câu `WHERE id = ANY(:ids)`) |
| `backend/cwd/entrypoints/api/routers/documents.py` | thêm 2 route `GET` |
| `backend/cwd/entrypoints/api/schemas/documents.py` | `DocumentOut`, `DocumentListOut`, `DocumentListQuery` |
| `backend/cwd/entrypoints/api/pagination.py` | `encode_cursor`, `decode_cursor` (dùng lại cho conversations/audit) |

### 4.3 `GET /api/v1/documents`

| Tham số | Kiểu | Ràng buộc | Mặc định |
|---|---|---|---|
| `q` | string | trim; 1..100 ký tự sau trim (đề xuất); rỗng thì coi như không lọc | — |
| `status` | CSV của `QUEUED,PROCESSING,READY,FAILED` | giá trị lạ → 400; `REMOVED` không được chấp nhận | tất cả trừ `REMOVED` |
| `page_size` | int | 1..100 | 50 |
| `cursor` | string | opaque, base64url của `{"u": "<uploaded_at ISO>", "i": "<id>"}` | — |

Truy vấn:

```sql
SELECT id, filename, size_bytes, page_count, status, error_reason, unreadable_pages, uploaded_by, uploaded_at
FROM docs.documents
WHERE removed_at IS NULL
  AND status = ANY(:statuses)
  AND (:q IS NULL OR f_unaccent(lower(filename)) LIKE '%' || f_unaccent(lower(:q_escaped)) || '%' ESCAPE '\')
  AND (:cu IS NULL OR (uploaded_at, id) < (:cu, :ci))
ORDER BY uploaded_at DESC, id DESC
LIMIT :page_size + 1;
```

- `q_escaped`: escape `\`, `%`, `_` trước khi ghép.
- Lấy `page_size + 1` dòng. Có dòng dư thì `next_cursor` = cursor của dòng thứ `page_size`, không thì `null`.
- `uploaded_by` → `{id, display_name}` qua `UserDirectory` (một lần gọi mỗi trang). User không còn → `display_name: "Người dùng đã rời"` (đề xuất).

```json
200 { "items": [ { "id": "0193…", "filename": "HoSoNangLuc_CongTy_2026.pdf", "size_bytes": 7340032, "page_count": 36,
                   "status": "READY", "error_reason": null, "unreadable_pages": 2,
                   "uploaded_by": { "id": "0192…", "display_name": "Trần Quốc Bảo" }, "uploaded_at": "2026-10-10T03:05:00Z" } ],
      "next_cursor": "eyJ1IjoiMjAyNi0xMC0xMFQwMzowNTowMFoiLCJpIjoiMDE5My4uLiJ9" }
```

Thêm (đề xuất) object `counts: {ready, processing, failed}` tính trên toàn kho, không theo `q`. ScopeBar và chân sidebar cần con số này kể cả khi danh sách đang được lọc.

### 4.4 `GET /api/v1/documents/{id}`

- 200 `DocumentOut` (cùng schema với phần tử danh sách, gồm `unreadable_pages`).
- 404 `NOT_FOUND` khi không tồn tại **hoặc** đã `REMOVED` (SAD §10.2). `id` sai định dạng UUID → 404, không trả 400, để không lộ thông tin định dạng.

### 4.5 Lỗi

| Mã | Khi nào |
|---|---|
| 400 `VALIDATION_ERROR` | `status` lạ, `page_size` ngoài 1..100, `cursor` hỏng, `q` > 100 ký tự |
| 401 / 403 | Theo T01-02 |
| 404 `NOT_FOUND` | Chi tiết: không có hoặc đã gỡ |

Mọi phản hồi có `Cache-Control: no-store` (T01-02).

## 5. Các bước thực hiện

- [ ] Viết migration 0104 và kiểm tra `EXPLAIN` dùng `documents_filename_trgm` khi `q` ≥ 3 ký tự.
- [ ] Viết `pagination.py` và test.
- [ ] Viết `DocumentRepository.list/get_active` và `UserDirectory.display_names`.
- [ ] Viết `ListDocuments`, `GetDocument`, router và schema Pydantic.
- [ ] Viết handler MSW `GET /api/v1/documents` dùng fixture chuyển từ `mock-data.js` (6 tài liệu đủ trạng thái, có `unreadable_pages = 2` và `scanned`), có mô phỏng chuyển trạng thái sau N lần poll.
- [ ] Seed dữ liệu test 1.000 tài liệu để đo hiệu năng.
- [ ] Cập nhật OpenAPI.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US003-1 (phía API):** kho có N tài liệu chưa gỡ (N = 0, 1, 120) → duyệt hết các trang cursor được đúng N phần tử, không trùng, không sót, theo `uploaded_at` giảm dần. Mỗi phần tử có `filename`, `uploaded_by.display_name`, `uploaded_at`, `status`. Tài liệu `REMOVED` không xuất hiện. Phần hiển thị kiểm ở T01-09.
- [ ] **AC-US003-2:** trên bộ seed 25 tài liệu: `q=hopdong` khớp "HopDong_PhuHung.pdf"; `q=hợp đồng` khớp "Hợp đồng thi công.pdf" và "HOP DONG mau.pdf"; `q=BÁO` khớp "bao_gia.pdf"; `q=Đường` khớp "duong_ong.pdf"; `q=50%` chỉ khớp tên chứa "50%". Không có tài liệu khớp → `items: []`. Lưu ý: `q=hop dong` (có khoảng trắng) **không** khớp "HopDong_PhuHung.pdf" (OQ-113).
- [ ] Hỗ trợ AC-US003-5 (AC ánh xạ ở T01-09): `GET /documents/{id}` trả `unreadable_pages` đúng với số trang `has_text = false` do T01-06 ghi.
- [ ] p95 ≤ 150 ms cho `GET /documents?page_size=50` và có `q` trên 1.000 tài liệu (đề xuất, đo ở integration test với PostgreSQL thật).
- [ ] Polling với `X-CWD-Background: 1` không gia hạn phiên (test với T01-01).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `encode/decode_cursor` round-trip; cursor bị sửa → `InvalidCursor`; escape `q` với `%`, `_`, `\` |
| Integration | 120 tài liệu, trong đó 3 tài liệu có cùng `uploaded_at` → keyset không trùng/sót qua 3 trang `page_size=50` |
| Integration | Lọc bỏ dấu và hoa thường theo bảng ở §6; `status=READY,FAILED`; `status=REMOVED` → 400 |
| Integration | Chi tiết: tài liệu đã gỡ → 404; UUID sai → 404; người dùng `lead` và `user` thấy cùng danh sách (kho chung, BR-002) |
| Hợp đồng | Schema phản hồi khớp `Document` ở SAD §10.2 (kiểm bằng `schemathesis` hoặc so khớp JSON Schema xuất từ OpenAPI) |

## 8. Analytics / observability

- Không có sự kiện EV (US-003 dùng EV-01 cho phễu).
- Metric RED mặc định cho route. Thêm nhãn `background=true|false` cho `http_server_duration` để tách lưu lượng polling (đề xuất).
- Không log `q`, vì tên tài liệu có thể nhạy cảm. Chỉ log `q_len`.

## 9. Tham chiếu

SAD §4.1 (polling), §7.1, §7.2, §9.1, §10.1, §10.2; ADR-011; USER_STORIES US-003; Blueprint §3.2.2 (`DocumentVM`).

## 10. Giả định và câu hỏi mở

- Giả định: kho trong pilot ≤ vài trăm tài liệu, nên SPA có thể tải hết các trang (T01-09).
- `counts` trong phản hồi danh sách là đề xuất, chưa có trong SAD §10.2.
- **OQ-113:** `q` khớp chuỗi con theo nghĩa đen sau khi bỏ dấu. "hop dong" (có khoảng trắng) không khớp "HopDong_x.pdf". Có cần chuẩn hoá thêm (bỏ `_`, `-`, khoảng trắng) để lọc "dễ tính" hơn không? AC-US003-2 chỉ yêu cầu "chứa chuỗi đó".
