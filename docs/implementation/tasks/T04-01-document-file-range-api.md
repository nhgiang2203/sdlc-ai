# T04-01 — API phục vụ file PDF có HTTP Range

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S4 (21/12/2026 – 01/01/2027) |
| Story / WP | US-016 · WP-40 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-04](T01-04-document-upload-api.md) (`S3ObjectStore`, khoá object `documents/{id}.pdf`) |
| Chặn | [T04-02](T04-02-fe-source-viewer.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp `GET /api/v1/documents/{id}/file` trả PDF gốc theo từng khoảng byte (HTTP Range, 206) để pdf.js trong SourceViewer chỉ tải các trang cần xem, mở đúng trang trích dẫn trong ≤ 2 s (AC-US016-1) mà không tải cả file 50 MB.

## 2. Bối cảnh

- SAD §4.1 (Xem PDF), §8.1 bước cuối (`GET /file (Range)` → `206 Partial Content`), §10.2 (endpoint, `Cache-Control: private, no-store`, 410 `DOCUMENT_REMOVED`), §10.4 IF-06 (S3 `GetObject` có Range, timeout 30 s), §11.2 (object storage lỗi → không xem PDF nhưng hỏi đáp vẫn chạy), §12.3 (vài trăm KB/trang).
- Kho tài liệu là kho chung: mọi người dùng có vai trò `user` được xem mọi tài liệu chưa gỡ (BR-001, BR-003).
- Tài liệu đã gỡ: `removed_at IS NOT NULL` → 410 ngay cả khi `purge_document` chưa xoá object (SAD §8.3 bước 5, EC-16).

## 3. Phạm vi

**Trong phạm vi:** router + use case đọc file; mở rộng `ObjectStorePort` với `stat()` và `open_range()`; phân tích header `Range`; header phản hồi; mã lỗi 404/410/416/503; cấu hình Nginx cho location này; metric; test.

**Ngoài phạm vi:** giao diện xem PDF, tô sáng ([T04-02](T04-02-fe-source-viewer.md)); luồng gỡ và purge ([T05-03](T05-03-document-removal-api.md)); CSP `worker-src 'self' blob:` (đã có ở [T00-07](T00-07-staging-deploy-nginx.md), T04-02 chỉ kiểm tra).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/ports/object_store.py` | Thêm `stat(key) -> ObjectStat(size, etag, last_modified)` và `open_range(key, start: int, end: int) -> AsyncIterator[bytes]` (end là byte cuối, bao gồm) |
| `backend/cwd/adapters/storage/s3_object_store.py` | `head_object`; `get_object(Range="bytes=a-b")`; đọc `StreamingBody` theo khối 64 KiB trong threadpool (`anyio.to_thread`) nếu dùng boto3 đồng bộ; 3 retry (SAD §11.2), timeout 30 s |
| `backend/cwd/domain/documents/byte_range.py` | `parse_range(header: str \| None, size: int) -> ByteRange \| None \| Unsatisfiable` — hàm thuần, không I/O |
| `backend/cwd/application/ingestion/get_document_file.py` | Use case `GetDocumentFile(document_id, range_header)`: nạp `Document`; kiểm tra trạng thái; gọi `stat` + `open_range` |
| `backend/cwd/entrypoints/api/routers/documents.py` | Route `GET /documents/{id}/file` trả `StreamingResponse` |

### 4.2 Hợp đồng

`GET /api/v1/documents/{id}/file` — vai trò `user`; không cần CSRF (GET).

| Trường hợp | Mã | Header chính | Body |
|---|---|---|---|
| Không có `Range` | 200 | `Content-Length: {size}`, `Accept-Ranges: bytes` | Toàn bộ file |
| `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` hợp lệ | 206 | `Content-Range: bytes a-b/{size}`, `Content-Length: b-a+1`, `Accept-Ranges: bytes` | Khoảng byte |
| Nhiều khoảng (`bytes=0-99,200-299`) | 200 | Như trên | Toàn bộ file (RFC 9110 cho phép bỏ qua; pdf.js không gửi multi-range) |
| Khoảng ngoài kích thước | 416 `RANGE_NOT_SATISFIABLE` | `Content-Range: bytes */{size}` | problem+json |
| Không tồn tại | 404 `NOT_FOUND` | — | problem+json |
| `removed_at IS NOT NULL` | 410 `DOCUMENT_REMOVED` | — | problem+json |
| Object storage lỗi / timeout | 503 `OBJECT_STORE_UNAVAILABLE` (đề xuất) | `Retry-After: 10` | problem+json |

Header chung cho 200/206: `Content-Type: application/pdf`; `Content-Disposition: inline; filename*=UTF-8''{filename percent-encoded}`; `Cache-Control: private, no-store`; `ETag: "{sha256}"` (dùng sha256 của tài liệu, ổn định hơn ETag S3 multipart); `X-Content-Type-Options: nosniff`; `Content-Security-Policy: sandbox` (đề xuất — khi người dùng mở URL trực tiếp trong tab, PDF không chạy script cùng origin).

- `If-Range` khớp `ETag` → xử lý Range; không khớp → 200 toàn file (đề xuất, chi phí thấp).
- Trạng thái `QUEUED`/`PROCESSING`/`FAILED`: vẫn phục vụ nếu object tồn tại (đề xuất — trích dẫn chỉ trỏ tới `READY`, nên chỉ có ý nghĩa khi người dùng mở trực tiếp; không cần chặn).
- Không ghi audit, không ghi analytics server (EV-12/EV-13 do client phát).

### 4.3 Logic `parse_range`

1. `None` hoặc không bắt đầu bằng `bytes=` → `None` (trả 200).
2. Có dấu phẩy → `None` (200 toàn file).
3. `a-b`: `a ≤ b`, `a < size`; `b = min(b, size-1)`. `a-`: `b = size-1`. `-n`: `n > 0`, `a = max(0, size-n)`.
4. Cú pháp sai → `None` (bỏ qua header, theo RFC 9110). `a ≥ size` → `Unsatisfiable`.

### 4.4 Nginx (bổ sung vào cấu hình của T00-07)

```nginx
location ~ ^/api/v1/documents/[0-9a-f-]+/file$ {
    proxy_pass http://cwd_api;
    proxy_buffering off;            # truyền thẳng khối byte
    proxy_max_temp_file_size 0;
    gzip off;                       # pdf.js yêu cầu không có Content-Encoding để dùng Range
    proxy_read_timeout 60s;
}
```

Header `Range`/`If-Range` được Nginx chuyển tiếp mặc định; không bật `proxy_cache`.

## 5. Các bước thực hiện

- [ ] Viết `parse_range` + unit test bảng (≥ 12 ca).
- [ ] Mở rộng `ObjectStorePort`, `S3ObjectStore`, fake in-memory cho test.
- [ ] Viết use case `GetDocumentFile` và route; ánh xạ ngoại lệ → mã lỗi RFC 9457 qua handler chung (T00-08).
- [ ] Cập nhật cấu hình Nginx staging; kiểm tra bằng `curl -H "Range: bytes=0-1023"` qua Nginx.
- [ ] Thêm route vào ma trận test phân quyền (IMPLEMENTATION_PLAN §10).
- [ ] Cập nhật tài liệu OpenAPI (mô tả 206/410/416).

## 6. Tiêu chí hoàn thành

Task không trực tiếp nghiệm thu AC nào (AC-US016-1..6 nghiệm thu ở T04-02); các tiêu chí kỹ thuật hỗ trợ:

- [ ] `Range: bytes=0-65535` trên PDF 20 MB trả 206, đúng 65.536 byte, `Content-Range` đúng; p90 ≤ 150 ms trên staging (đề xuất) — hỗ trợ AC-US016-1.
- [ ] Tài liệu đã gỡ trả 410 `DOCUMENT_REMOVED` kể cả khi object còn — hỗ trợ AC-US016-4.
- [ ] Object storage tắt → 503 problem+json trong ≤ 30 s, các endpoint khác không bị ảnh hưởng — hỗ trợ AC-US016-5.
- [ ] Mọi phản hồi 200/206 có `Cache-Control: private, no-store` và không có `Content-Encoding`.
- [ ] Không có phiên → 401; không có vai trò `user` → 403.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `parse_range`: không header; `bytes=0-0`; `bytes=0-`; `bytes=-500`; `bytes=-0` (bỏ qua); `bytes=10-5` (bỏ qua); `bytes=size-` (416); multi-range; `items=0-1`; giá trị âm; số rất lớn (b > size) |
| Integration (Testcontainers + SeaweedFS) | 200 toàn file khớp sha256; 206 nối lại các khoảng 64 KiB khớp sha256; 404 id lạ; 410 sau khi đặt `removed_at`; 416; S3 dừng container → 503 |
| Hợp đồng | Header bắt buộc (`Accept-Ranges`, `Content-Disposition` với tên có dấu tiếng Việt `HợpĐồng_X.pdf`) |
| Thủ công (staging) | Mở PDF 500 trang bằng pdf.js demo trỏ tới URL qua Nginx: DevTools chỉ thấy các request 206 nhỏ, không tải hết file |

## 8. Analytics / observability

- Span OTel `documents.file` với `document_id`, `range_bytes`, `status`; không ghi tên file vào span (PR-06).
- Metric `cwd_document_file_bytes_total` (counter) và RED chuẩn của endpoint; lỗi object storage tăng `cwd_object_store_errors_total{op="get"}` (đề xuất).

## 9. Tham chiếu

SAD §4.1, §4.3 (object storage), §8.1, §8.3, §10.1–10.2, §10.4 IF-06, §11.2; USER_STORIES US-016; PRD EC-16, EC-23; RFC 9110 §14 (Range).

## 10. Giả định và câu hỏi mở

- Giả định: `S3ObjectStore` của T01-04 dùng boto3; nếu dùng client async (aioboto3) thì bỏ threadpool.
- **OQ-T0401-01:** Có cần phục vụ file cho tài liệu chưa `READY` không? Đề xuất: có (không gây hại); nếu Bảo mật muốn chặn thì trả 409 `DOCUMENT_NOT_READY`.
- **OQ-T0401-02:** Thêm `Content-Security-Policy: sandbox` cho phản hồi PDF có làm Chrome/Edge hiển thị sai trình xem PDF tích hợp khi mở trực tiếp không? Cần thử trên 2 trình duyệt hỗ trợ (NFR-007).
