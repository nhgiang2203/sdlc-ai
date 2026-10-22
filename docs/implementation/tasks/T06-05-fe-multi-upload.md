# T06-05 — FE: tải nhiều file, lớp phủ thả file

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-006 · WP-63 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-08](T01-08-fe-upload-dropzone.md) (upload một file bằng XHR có tiến trình), [T02-09](T02-09-fe-document-errors.md) (từ chối phía client, lý do lỗi) |
| Chặn | [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cho phép chọn hoặc thả nhiều PDF trong một thao tác: mỗi file thành một mục có trạng thái và tiến trình riêng, file không hợp lệ bị từ chối mà không chặn file khác, tối đa 3 request tải lên song song, xử lý 429 (giới hạn 30 lượt/giờ), và lớp phủ "Thả để thêm vào kho" khi kéo file vào bất kỳ vị trí nào trên màn hình chính.

## 2. Bối cảnh

- US-006 (P2, PER-02 nạp cả bộ hồ sơ dự án), UF-04 Blueprint §3.4, UX-06 PRD §5.1, EC-04 (mất mạng một file không ảnh hưởng file khác).
- SAD §4.1: "mỗi file một request độc lập (EC-04, US-006)"; §11.2 rate limit 30 tải lên/giờ/người, 429 + `Retry-After`; §10.1 header `RateLimit-Remaining`.
- Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js) (`handleFiles`, `dragenter/dragleave/drop` đếm `dragDepth`, `#drag-overlay`), [workspace.html](../../design/UI_UX_design/workspace.html) (`.drag-overlay`), máy trạng thái UploadItem Blueprint §3.7.2.
- Thứ tự cắt khi thiếu dung lượng S6: US-022 → **US-006** → US-017.

## 3. Phạm vi

**Trong phạm vi:** `input multiple`; hàng đợi tải lên giới hạn 3 song song; xử lý từng file theo máy trạng thái §3.7.2; hàng đợi hộp thoại trùng lặp; xử lý 429; lớp phủ toàn màn hình chính; EV-03 có `batch_size`; test.

**Ngoài phạm vi:** API upload, 409/413/415 (T01-04, T02-08); kiểm tra một file và thông điệp lỗi (T01-08, T02-09 — tái sử dụng); kéo thả thư mục (bỏ qua mục không phải file); tải lên tiếp tục (resumable).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/features/documents/upload/uploadQueue.ts` | Store Zustand `useUploadQueue`: `items: UploadItemVM[]`, `enqueue(files: File[])`, `retry(id)`, `dismiss(id)`, `confirmDuplicate(id, ok)`; bộ lập lịch `MAX_CONCURRENT = 3` |
| `frontend/src/features/documents/upload/uploadFile.ts` | (từ T01-08) XHR multipart, `onprogress`, trả `{status, body, headers}`; thêm đọc `Retry-After`, `RateLimit-Remaining` |
| `frontend/src/features/documents/upload/validateFile.ts` | (từ T02-09) đuôi `.pdf`, MIME, ≤ 50 MB |
| `frontend/src/features/documents/upload/UploadDropzone.tsx` | Thêm `multiple`; state `rate-limited` hiển thị thời điểm mở lại |
| `frontend/src/features/documents/upload/GlobalDropOverlay.tsx` | Lắng nghe `dragenter/dragover/dragleave/drop` trên `window`; lớp phủ `role="dialog"` `aria-modal="false"`, icon upload, tiêu đề "Thả để thêm vào kho", phụ đề "Chỉ hỗ trợ PDF, tối đa 50 MB mỗi file" |
| `frontend/src/features/documents/upload/DuplicatePromptHost.tsx` | Hiển thị lần lượt từng `ConfirmDialog` trùng lặp (một hộp thoại tại một thời điểm) |
| `frontend/src/app/WorkspacePage.tsx` | Gắn `GlobalDropOverlay` chỉ trên route `/` và `/c/:id` (màn hình chính), không trên `/stats`, `/documents/audit`, `/history` (đề xuất) |

### 4.2 Hàng đợi và máy trạng thái

`UploadItemVM = { id, file, name, size, state, progress, reason?, retryAt?, documentId? }`, `state ∈ validating | rejected | waiting | uploading | interrupted | duplicate_prompt | rate_limited | queued | processing | ready | failed`.

1. `enqueue(files)`: lọc mục không phải `File` (thư mục), với mỗi file chạy `validateFile` → `rejected` (giữ lý do "Chỉ hỗ trợ file PDF." / "File vượt quá 50 MB.") hoặc `waiting`. Mục mới chèn đầu danh sách theo đúng thứ tự người dùng chọn.
2. Bộ lập lịch lấy `waiting` theo FIFO khi số `uploading` < 3.
3. Kết quả từng request:
   - 201 → `queued`, chuyển cho polling danh sách tài liệu (T01-09) theo `documentId`.
   - 409 `DUPLICATE_DOCUMENT` → `duplicate_prompt`; `DuplicatePromptHost` hỏi lần lượt; xác nhận → gửi lại với `confirm_duplicate=true`, huỷ → xoá mục (EV-04 `duplicate_cancelled`). Mục chờ xác nhận **không chiếm** suất song song.
   - 413/415 → `rejected` với lý do từ T02-09.
   - 429 → mục hiện tại và **mọi mục `waiting`** chuyển `rate_limited`, `retryAt = now + Retry-After`; dừng bộ lập lịch tới `retryAt`. Thông báo trên mục và dropzone: "Đã đạt giới hạn tải lên, thử lại sau X phút" (X = làm tròn lên phút). Hết hạn → không tự gửi (đề xuất, tránh vượt lần nữa); hiện nút "Thử lại tất cả".
   - Lỗi mạng/`onerror`/`ontimeout` → `interrupted` "Tải lên bị gián đoạn" + "Thử lại" (EC-04); các mục khác tiếp tục.
4. `RateLimit-Remaining` ≤ số mục còn chờ → hiển thị cảnh báo vàng trước "Chỉ còn N lượt tải lên trong giờ này" (đề xuất).

### 4.3 Lớp phủ kéo-thả

- Chỉ kích hoạt khi `event.dataTransfer.types` chứa `"Files"` (không bật khi kéo văn bản/ảnh trong trang).
- Đếm `dragDepth` như prototype để không nhấp nháy khi đi qua phần tử con; `dragover` luôn `preventDefault()` để trình duyệt không mở PDF.
- `drop` ở bất kỳ đâu → ẩn lớp phủ → `enqueue([...dataTransfer.files])`. Phím `Esc` hoặc rời cửa sổ → ẩn.
- Không kích hoạt khi đang mở `ConfirmDialog`/`SourceViewer` overlay (đề xuất: vẫn nhận nhưng hộp thoại có thứ tự ưu tiên — chọn "không kích hoạt" cho đơn giản).
- Tôn trọng `prefers-reduced-motion` (không fade).

### 4.4 Accessibility

`DocumentRow` mỗi mục có `progressbar` `aria-valuenow`; vùng `aria-live="polite"` thông báo tóm tắt "Đang tải 3 trên 10 file", "9 file đã tải lên, 1 file bị từ chối". Lớp phủ chỉ là gợi ý thị giác; người dùng bàn phím dùng nút "Chọn file" (input `multiple`).

## 5. Các bước thực hiện

- [ ] Tách logic một file của T01-08 thành `uploadFile.ts` thuần (không phụ thuộc component).
- [ ] Viết `uploadQueue.ts` + unit test bộ lập lịch (fake XHR).
- [ ] `DuplicatePromptHost`, xử lý 409 tuần tự.
- [ ] Xử lý 429, `RateLimit-Remaining`.
- [ ] `GlobalDropOverlay` + gắn vào `WorkspacePage`.
- [ ] Cập nhật `UploadDropzone` (`multiple`, `rate-limited`), `DocumentRow` (state `waiting`, `rate_limited`).
- [ ] EV-03 với `batch_size`.
- [ ] Playwright: thả 10 file (MSW giả tiến trình), 1 file `.docx`, mất mạng giữa chừng, 429 ở file thứ 4.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US006-1:** chọn/thả 10 PDF hợp lệ → 10 mục vào danh sách, mỗi mục có trạng thái và thanh tiến trình riêng; tại mọi thời điểm ≤ 3 request đang chạy (kiểm bằng MSW đếm request đồng thời).
- [ ] **AC-US006-2:** 10 file trong đó 1 file không phải PDF → file đó `rejected` với lý do "Chỉ hỗ trợ file PDF.", 9 file còn lại vẫn tải lên thành công; EV-04 `not_pdf` được phát một lần.
- [ ] **AC-US006-3:** kéo file vào bất kỳ vị trí nào trên màn hình chính (cột kho, vùng hội thoại, vùng xem tài liệu) → lớp phủ "Thả để thêm vào kho" xuất hiện; kéo ra ngoài → biến mất; kéo văn bản không bật lớp phủ.
- [ ] 429 → thông báo "Đã đạt giới hạn tải lên, thử lại sau X phút", không gửi thêm request tới khi người dùng thử lại sau `retryAt`.
- [ ] EC-04: một file bị gián đoạn không ảnh hưởng các file khác (E2E với `context.setOffline`).
- [ ] axe 0 lỗi serious/critical với lớp phủ đang hiển thị và danh sách 10 mục.

## 7. Kiểm thử

| Tầng | Ca |
|---|---|
| Vitest | Bộ lập lịch: 10 file → tối đa 3 song song, FIFO; 409 không chiếm suất; 429 dừng hàng đợi; retry mục `interrupted` |
| Testing Library | `GlobalDropOverlay` với `dragenter` lồng nhau; `types` không có `Files` |
| Playwright | AC-US006-1..3; Chrome + Edge; tệp mẫu từ bộ PDF QA (DEP-002) |
| Staging | Thả 10 PDF thật (~5 MB/file), xác nhận cả 10 đạt `READY` và EV-03 có `batch_size = 10` |

## 8. Analytics / observability

- EV-03 `document_upload_started` mỗi file, `batch_size` = số file hợp lệ + không hợp lệ trong lần thả/chọn (đề xuất: tổng số file người dùng đưa vào, xem OQ-168), `file_size_mb`, `document_id` (sau 201 — theo quy ước của T01-08/T01-10).
- EV-04 `document_upload_rejected` cho từng file bị từ chối phía client.

## 9. Tham chiếu

- USER_STORIES US-006 (ghi chú kỹ thuật: XHR, 3 song song, 429); PRD §5.1 UX-06, §5.2 EC-04, EC-08, EC-11, §6.2 EV-03/EV-04.
- SAD §4.1 (Tải lên), §10.1, §10.2 `POST /documents`, §11.2 rate limiting.
- Blueprint §3.4 UF-04, §3.6.2 `UploadDropzone`, `DocumentRow`, §3.7.2; prototype `workspace.js`, `workspace.html`, `components.css` (`.drag-overlay`, `.progress`).

## 10. Giả định và câu hỏi mở

- Giả định: API trả `Retry-After` (giây) và `RateLimit-Remaining` cho `POST /documents` (T01-02).
- Giả định: không giới hạn số file mỗi lần thả; rate limit 30/giờ là giới hạn thực tế.
- **OQ-168 (mới):** `batch_size` của EV-03 tính tổng file người dùng thả hay chỉ file hợp lệ được tải lên? Owner: PO.
- OQ-004 (kế thừa): giới hạn 50 MB/500 trang ảnh hưởng thông điệp từ chối.
