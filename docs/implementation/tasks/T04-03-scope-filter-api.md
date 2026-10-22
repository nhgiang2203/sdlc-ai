# T04-03 — Giới hạn phạm vi tài liệu phía API

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S4 (21/12/2026 – 01/01/2027) |
| Story / WP | US-013 · WP-41 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T02-05](T02-05-ask-question-sse.md) (`AskQuestion` + SSE), [T02-02](T02-02-hybrid-retrieval-rerank.md) (truy vấn lai) |
| Chặn | [T04-04](T04-04-fe-scope-selection.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cho phép `POST /conversations/{id}/messages` nhận `scope_document_ids` (≤ 200) để chỉ truy xuất trong các tài liệu đã chọn, không bị thiếu kết quả khi lọc trên chỉ mục HNSW, và lưu phạm vi thực tế vào `messages.scope_document_ids`.

## 2. Bối cảnh

- T02-05 hiện luôn tìm trong toàn kho (`scope_ids = NULL`).
- SAD §4.2 bước 1 (phạm vi chỉ gồm tài liệu `READY`, chưa gỡ) và bước 4 (lọc `document_id = ANY(scope)`); §4.3 (`hnsw.ef_search = 80`, `hnsw.iterative_scan = relaxed_order`); §7.2 (truy vấn lai với CTE `scope`); §10.2 (request `{question, scope_document_ids?: uuid[] (≤ 200)}`, 400 `VALIDATION_ERROR`, 409 `NO_READY_DOCUMENTS`); §10.3 `meta.docs_in_scope`, `meta.docs_processing`.
- PostgreSQL chạy sau PgBouncer transaction pooling (SAD §4.3): tham số phiên phải đặt bằng `SET LOCAL` trong giao dịch.

## 3. Phạm vi

**Trong phạm vi:** schema request; tính phạm vi hiệu lực; tham số pgvector; điều chỉnh SQL; lưu `scope_document_ids`; `meta`; trường EV-08 `scope_type`, `docs_in_scope`; ghi chú phạm vi cho câu not_found; test.

**Ngoài phạm vi:** checkbox, `ScopeBar`, vô hiệu ô hỏi ([T04-04](T04-04-fe-scope-selection.md)); EV-14 (client, T04-04); viết lại câu hỏi ([T05-01](T05-01-follow-up-rewrite-history.md)).

## 4. Thiết kế chi tiết

### 4.1 Request và kiểm tra

`backend/cwd/entrypoints/api/schemas/messages.py`:

```python
class AskQuestionIn(BaseModel):
    question: constr(strip_whitespace=True, min_length=1, max_length=2000)
    scope_document_ids: conlist(UUID, max_length=200) | None = None
```

| Đầu vào | Xử lý |
|---|---|
| Thiếu trường, `null` hoặc `[]` | Phạm vi = toàn kho (AC-US013-3); `scope_type = "all"` |
| > 200 phần tử | 400 `VALIDATION_ERROR` (`detail`: "Tối đa 200 tài liệu trong phạm vi") |
| Phần tử không phải UUID | 400 `VALIDATION_ERROR` |
| Trùng lặp | Loại trùng trước khi đếm (đề xuất) |
| ID không tồn tại / đã gỡ / `FAILED` | Bỏ qua (không lộ thông tin, kho chung) |
| Sau giao không còn tài liệu `READY` | 409 `NO_READY_DOCUMENTS` với `detail` "Các tài liệu đã chọn chưa sẵn sàng" và `extensions.scope = "selected"` (đề xuất, dùng lại mã SAD thay vì tạo mã mới) |

Kiểm tra xảy ra **trước khi mở SSE** (cùng chỗ với rate limit và 409 hiện có).

### 4.2 Phạm vi hiệu lực

`backend/cwd/application/qa/resolve_scope.py` — `ResolveScope(requested_ids) -> Scope(ready_ids | None, processing_count, scope_type)`:

- Toàn kho: `ready_ids = None`; `docs_in_scope = COUNT(*) READY`; `docs_processing = COUNT(*) QUEUED|PROCESSING`.
- Đã chọn: một câu `SELECT id, status FROM docs.documents WHERE id = ANY(:ids) AND removed_at IS NULL`; `ready_ids` = các id `READY`; `docs_processing` = số id được chọn đang `QUEUED|PROCESSING` (để FE ghi chú "1 tài liệu đã chọn đang xử lý chưa được dùng").
- Đi qua `DocumentRepository` (module `docs`), không truy vấn chéo schema từ `qa` (SAD §7.1).

### 4.3 Truy vấn lai

`backend/cwd/adapters/postgres/chunk_search.py` (của T02-02), trong cùng giao dịch:

```sql
SET LOCAL hnsw.ef_search = 80;
SET LOCAL hnsw.iterative_scan = relaxed_order;
SET LOCAL hnsw.max_scan_tuples = 20000;   -- mặc định pgvector, ghi rõ để tinh chỉnh
```

- CTE `vec` bọc lại để sắp xếp chính xác sau `relaxed_order` (khuyến nghị của pgvector):

```sql
vec AS MATERIALIZED (
  SELECT id, embedding <=> :qvec AS dist FROM docs.chunks
  WHERE document_id IN (SELECT id FROM scope)
  ORDER BY embedding <=> :qvec LIMIT 40
), vec_ranked AS (
  SELECT id, row_number() OVER (ORDER BY dist) AS r FROM vec
)
```

- `:scope_ids` truyền `NULL` cho toàn kho, `uuid[]` cho phạm vi chọn; giữ nguyên nhánh `fts`.
- Với phạm vi nhỏ, planner có thể chọn btree(`document_id`) + sắp xếp chính xác thay vì HNSW — chấp nhận được (kết quả đúng hơn). Ghi `EXPLAIN (ANALYZE, BUFFERS)` cho 3 cỡ phạm vi (1, 20, 200 tài liệu) vào PR.

### 4.4 Lưu và phát sự kiện

- `conv.messages.scope_document_ids` của message **user**: `NULL` khi toàn kho, ngược lại là `ready_ids` đã dùng (đề xuất lưu phạm vi hiệu lực, không phải phạm vi yêu cầu — để tái hiện đúng câu trả lời).
- SSE `meta`: `docs_in_scope = len(ready_ids)` hoặc tổng READY; `docs_processing` như §4.2; thêm `scope_type: "all"|"selected"` (đề xuất, FE dùng để viết "Đã tìm trong 3 tài liệu đã chọn").
- EV-08 (server-side, T02-05): bổ sung `scope_type`, `docs_in_scope`.
- Cổng τ_nf (T03-02) không đổi; câu not_found theo phạm vi (AC-US013-2) đến tự nhiên vì truy xuất chỉ thấy tài liệu trong phạm vi.

## 5. Các bước thực hiện

- [ ] Thêm trường request + test validation.
- [ ] Viết `ResolveScope` + phương thức repository `get_statuses(ids)`.
- [ ] Sửa SQL truy xuất: `SET LOCAL`, CTE `MATERIALIZED`, tham số `:scope_ids`.
- [ ] Lưu `scope_document_ids`; mở rộng `meta` và EV-08.
- [ ] Tạo dữ liệu test 200 tài liệu × 50 đoạn để kiểm tra recall khi lọc.
- [ ] Bổ sung 5 câu golden set dạng "có phạm vi" (đáp án ngoài phạm vi → not_found) phối hợp QA (T03-01).
- [ ] Chạy golden set: không hồi quy > 3 điểm %.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US013-2:** với phạm vi 3 tài liệu, câu hỏi chỉ có đáp án ngoài 3 tài liệu nhận `answer_type = not_found` (test integration với `FakeLLMAdapter` + golden set có phạm vi trên staging).
- [ ] Hỗ trợ AC-US013-1 (nghiệm thu ở T04-04): mọi citation trả về có `document_id ∈ ready_ids` — test thuộc tính trên 50 câu ngẫu nhiên.
- [ ] Hỗ trợ AC-US013-3: `[]`/thiếu trường → toàn kho, `scope_document_ids` lưu `NULL`.
- [ ] Hỗ trợ AC-US013-4: phạm vi chỉ gồm tài liệu `PROCESSING`/`FAILED` → 409 `NO_READY_DOCUMENTS`, không mở SSE.
- [ ] Recall@40 của nhánh vector khi lọc phạm vi 5 tài liệu trong kho 200 tài liệu = 100% so với tìm chính xác (brute force) trên 30 truy vấn mẫu.
- [ ] 201 phần tử → 400; trace không chứa danh sách id đầy đủ (chỉ `scope_size`).

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `ResolveScope`: rỗng, toàn READY, trộn READY/PROCESSING/FAILED/đã gỡ/id lạ, toàn không READY |
| Integration (Testcontainers pgvector ≥ 0.8) | Kho 200 tài liệu; phạm vi 1/5/200; so sánh top-40 với truy vấn `ORDER BY` không chỉ mục (`SET enable_indexscan = off`); kiểm tra `SET LOCAL` không rò sang giao dịch sau (qua PgBouncer container) |
| API | 400 khi 201 id; 409 khi phạm vi không READY; SSE `meta.docs_in_scope = 3`, `scope_type = "selected"` |
| Chất lượng | Golden set nhóm có phạm vi trong báo cáo PR |

## 8. Analytics / observability

- EV-08 `scope_type`, `docs_in_scope` (P0).
- Span `qa.retrieve` thêm thuộc tính `scope_type`, `scope_size`; metric `cwd_retrieval_seconds{stage="vector_search", scope="selected"}` (đề xuất nhãn `scope` để so độ trễ).

## 9. Tham chiếu

SAD §4.2, §4.3, §7.1, §7.2, §10.2, §10.3; USER_STORIES US-013; PRD EC-18; tài liệu pgvector 0.8 "iterative index scans".

## 10. Giả định và câu hỏi mở

- Giả định: T02-01 đã có cột `scope_document_ids uuid[]` trong `conv.messages` (SAD §7.2); nếu chưa, task này thêm migration expand.
- **OQ-T0403-01:** Lưu phạm vi yêu cầu hay phạm vi hiệu lực? Đề xuất hiệu lực; nếu US-017 (mở lại hội thoại) muốn khôi phục lựa chọn checkbox thì cần thêm cột phạm vi yêu cầu.
- **OQ-T0403-02:** Có cần mã lỗi riêng `SCOPE_NOT_READY` thay vì dùng lại `NO_READY_DOCUMENTS` không? SAD chỉ có mã sau; đề xuất dùng lại kèm `extensions.scope`.
