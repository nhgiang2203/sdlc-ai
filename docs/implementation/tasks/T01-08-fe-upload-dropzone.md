# T01-08 — FE: vùng tải lên một file có tiến trình

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-002 · WP-11 |
| Loại | FE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-03](T01-03-fe-auth-api-client.md) (thực tế cũng cần hợp đồng [T01-04](T01-04-document-upload-api.md)) |
| Chặn | [T02-09](T02-09-fe-document-errors.md), [T06-05](T06-05-fe-multi-upload.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Người dùng kéo-thả hoặc chọn một file PDF trong cột kho tài liệu và thấy file xuất hiện ngay trong danh sách với thanh tiến trình tải lên. Nếu file trùng thì có hộp thoại xác nhận. Nếu mất mạng giữa chừng thì file chuyển "Tải lên bị gián đoạn" và có nút "Thử lại". Tải lên xong, file trở thành tài liệu "Đang xử lý".

## 2. Bối cảnh

- SAD §4.1 "Tải lên": kiểm tra phía client (đuôi `.pdf`, MIME, ≤ 50 MB) → `XMLHttpRequest` multipart để có tiến trình; mỗi file một request độc lập. SAD §8.2 (409 `DUPLICATE_DOCUMENT`, 201 `QUEUED`).
- Blueprint §3.6.2 (`UploadDropzone`, `DocumentRow` trạng thái `uploading`, `interrupted`, `rejected`), §3.7.2 (máy trạng thái UploadItem), §3.5.2 (`uploadQueue` trong Zustand, mất khi tải lại trang), §3.5.3 (form tải lên).
- Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js) có `handleFiles`, `runUpload`, `finishUpload`, `uploadBadge`, và section "Đang tải lên" trong `renderSidebar`.
- Lớp phủ kéo-thả toàn màn hình (UX-06) và chọn nhiều file thuộc T06-05.

## 3. Phạm vi

**Trong phạm vi:** `features/documents/upload/*`: `UploadDropzone` (nút + vùng thả trong sidebar), `useUploadQueue` (Zustand), `uploadDocument()` (XHR), `UploadRow` (biến thể của `DocumentRow` cho `UploadItemVM`), `DuplicateDialog` (dùng `ConfirmDialog`); kiểm tra phía client cơ bản; xử lý 201/409/413/415/429/401/mạng; phát EV-03, EV-04.

**Ngoài phạm vi:** lớp phủ toàn màn hình, nhiều file một lần (T06-05); thông điệp từ chối hoàn chỉnh, test AC-US004-1/2 và "Xoá khỏi danh sách" (T02-09); hiển thị danh sách tài liệu và polling (T01-09); tự thử lại khi có mạng (không làm, chỉ thông báo).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Nội dung |
|---|---|
| `frontend/src/features/documents/upload/UploadDropzone.tsx` | `<button class="dropzone">` "Thêm tài liệu PDF" / "Kéo-thả hoặc bấm để chọn · tối đa 50 MB/file" + `<input type="file" accept="application/pdf,.pdf" hidden>` (không có `multiple`) + xử lý `dragover`/`drop` trên chính vùng này |
| `frontend/src/features/documents/upload/uploadQueue.ts` | Zustand store `useUploadQueue` |
| `frontend/src/features/documents/upload/uploadDocument.ts` | `uploadDocument(file, {confirmDuplicate, onProgress, signal}) -> Promise<DocumentDto>` |
| `frontend/src/features/documents/upload/validateFile.ts` | `validateFile(file) -> RejectReason \| null` |
| `frontend/src/features/documents/upload/UploadRow.tsx` | Hiển thị một `UploadItemVM` |
| `frontend/src/features/documents/upload/DuplicateDialog.tsx` | Hộp thoại trùng |
| `frontend/src/features/documents/upload/useFilePicker.ts` | `openPicker()` dùng chung cho EmptyState "Chọn file" (T01-09) |
| `frontend/src/mocks/handlers/documents.ts` | Bổ sung kịch bản `POST` (tiến trình giả, 409 khi tên chứa `dup`, 413, 415, 429, lỗi mạng) |

### 4.2 State (`useUploadQueue`)

```ts
type UploadState = "validating" | "rejected" | "uploading" | "interrupted" | "duplicatePrompt";
interface UploadItemVM {           // Blueprint §3.2.2, bổ sung `file`, `duplicateOf`
  localId: string; filename: string; sizeBytes: number; state: UploadState;
  progressPct: number; rejectReason?: string; documentId?: string;
  file: File;                      // giữ tham chiếu để Thử lại (chỉ trong bộ nhớ)
  duplicateOf?: { id: string; filename: string; uploadedAt: string };
}
actions: add(file), start(localId, confirmDuplicate?), setProgress, markInterrupted, markRejected,
         promptDuplicate, resolveDuplicate(localId, confirm: boolean), complete(localId, doc), dismiss(localId)
```

Không lưu vào `sessionStorage`/`localStorage` (Blueprint §3.5.2). Tải lại trang thì mất hàng đợi; file đã tải xong vẫn còn trên server.

### 4.3 Máy trạng thái (Blueprint §3.7.2)

| Từ | Sự kiện | Đến | Hiển thị |
|---|---|---|---|
| — | chọn/thả 1 file | `validating` | Badge neutral "Đang kiểm tra" |
| `validating` | không phải PDF / > 50 MB | `rejected` | Badge danger "Không được chấp nhận" + `doc-error`: "Chỉ hỗ trợ file PDF." / "File vượt quá 50 MB." + nút ✕ "Bỏ qua" |
| `validating` | hợp lệ | `uploading` | Badge info "Đang tải lên {n}%" + `progress` (`role="progressbar"`, `aria-valuenow`) |
| `uploading` | `xhr.onerror` / `ontimeout` / `offline` | `interrupted` | Badge danger + icon wifiOff "Tải lên bị gián đoạn" + "Mất kết nối khi đang tải lên." + nút "Thử lại" (`refresh`) và "Bỏ qua" |
| `interrupted` | "Thử lại" | `uploading` (gửi lại từ đầu) | Đang offline thì toast danger "Vẫn chưa có kết nối mạng." và giữ `interrupted` |
| `uploading` | 409 `DUPLICATE_DOCUMENT` | `duplicatePrompt` | Mở `DuplicateDialog` |
| `duplicatePrompt` | "Vẫn thêm" | `uploading` với `confirm_duplicate=true` | — |
| `duplicatePrompt` | "Huỷ" / Esc | xoá khỏi hàng đợi | EV-04 `duplicate_cancelled` |
| `uploading` | 201 | xoá khỏi hàng đợi; tài liệu vào cache `["documents"]` (đặt đầu danh sách, `QUEUED` → "Đang xử lý") + `invalidateQueries` | Toast không bắt buộc |
| `uploading` | 413 / 415 | `rejected` với thông điệp tương ứng | — |
| `uploading` | 429 | `rejected`: "Bạn đã tải lên quá nhiều file. Vui lòng thử lại sau {s} giây." (đề xuất) | — |
| `uploading` | 401 | Chuyển sang luồng hết phiên của T01-03, hàng đợi bị mất | — |

`DuplicateDialog`: tiêu đề "Tài liệu này đã có trong kho"; thân "“{tên}” trùng nội dung với tài liệu “{existing_filename}” đã tải lên ngày {dd/MM/yyyy}. Vẫn thêm bản này?"; nút "Vẫn thêm" (primary) và "Huỷ". Focus ban đầu ở "Huỷ", có focus trap, Esc để huỷ (theo `confirmDialog` của prototype, dùng Radix Dialog).

### 4.4 `uploadDocument` (XHR)

- `POST /api/v1/documents`, `FormData{file, confirm_duplicate}`, `withCredentials = true`, header `X-CSRF-Token` (dùng `readCsrfToken` từ `lib/api/csrf`).
- `xhr.upload.onprogress` → `progressPct = floor(loaded/total × 100)`, cập nhật store tối đa 10 lần/giây. Khi bytes đã gửi hết mà chưa có phản hồi thì giữ 99% để tránh báo xong sớm.
- `xhr.timeout = 0` (không cắt theo thời gian). `AbortSignal` → `xhr.abort()` khi người dùng bấm "Bỏ qua" lúc đang tải (đề xuất).
- Phản hồi lỗi → `parseProblem` (tái sử dụng `lib/api/problem`) → `ApiError`.
- `window` `offline` khi đang `uploading` → `xhr.abort()` + `interrupted`. Sự kiện `online` → toast info "Đã có mạng trở lại. Bấm Thử lại để tải tiếp các file bị gián đoạn." nếu còn mục `interrupted` (EC-04).

### 4.5 Kiểm tra phía client (`validateFile`)

`/\.pdf$/i.test(name)` **và** (`type === "application/pdf"` hoặc `type === ""`); `size ≤ 52_428_800`; `size > 0`. Thả nhiều file (S1) → chỉ nhận file đầu tiên, toast info "Hiện mỗi lần chỉ thêm được một file." (đề xuất tạm thời, T06-05 gỡ bỏ).

## 5. Các bước thực hiện

- [ ] Viết `validateFile` + unit test.
- [ ] Viết `uploadDocument` (XHR) + unit test với `xhr-mock` hoặc MSW (`msw` hỗ trợ XHR).
- [ ] Viết store `useUploadQueue` + test chuyển trạng thái.
- [ ] Viết `UploadDropzone`, `UploadRow`, `DuplicateDialog` bằng token/primitive design-system (`dropzone`, `badge-*`, `progress`, `doc-error`).
- [ ] Gắn section "Đang tải lên" phía trên danh sách trong `DocumentSidebar` (phối hợp T01-09: sidebar nhận `uploads` qua store).
- [ ] Viết `useFilePicker` cho EmptyState.
- [ ] Phát sự kiện EV-03, EV-04 qua `lib/analytics` (T01-10).
- [ ] Viết E2E Playwright.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US002-1:** chọn hoặc thả PDF hợp lệ → trong ≤ 200 ms có dòng trong section "Đang tải lên" với tên, dung lượng và thanh tiến trình tăng dần; sau 201 dòng chuyển thành tài liệu "Đang xử lý" ở đầu danh sách mà không cần tải lại trang.
- [ ] **AC-US002-4:** tải lại file đã có → hộp thoại "Tài liệu này đã có trong kho"; "Huỷ" → không có tài liệu mới; "Vẫn thêm" → tài liệu mới xuất hiện (hai bản cùng tên trong danh sách).
- [ ] **AC-US002-5:** ngắt mạng khi đang tải (Playwright `context.setOffline(true)`) → dòng chuyển "Tải lên bị gián đoạn" + "Thử lại"; có mạng lại → hiện thông báo; bấm "Thử lại" → tải thành công. Danh sách tài liệu và các dòng khác không bị ảnh hưởng.
- [ ] Bàn phím: Tab tới dropzone, Enter/Space mở hộp chọn file; thanh tiến trình có `aria-label` "Tiến trình tải {tên}"; thay đổi trạng thái được đọc qua vùng `aria-live`.
- [ ] axe-core không có lỗi nghiêm trọng ở trạng thái `uploading`, `interrupted`, `rejected`, khi mở hộp thoại trùng.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `validateFile`: `a.PDF` + `application/pdf` OK; `a.pdf` + `image/png` → not_pdf; `a.docx` → not_pdf; 50 MB đúng ngưỡng OK; 50 MB + 1 → too_large; 0 byte → bị từ chối |
| Unit | Store: mọi chuyển trạng thái ở §4.3; `dismiss` khi đang `uploading` gọi abort |
| Component | `UploadRow` render đúng nhãn/nút cho 4 trạng thái; `DuplicateDialog` focus "Huỷ", Esc → huỷ |
| E2E (MSW) | 409 → xác nhận → 201; 415; 413; 429 hiển thị số giây |
| E2E (staging) | Tải `normal_10p.pdf` thật → "Đang xử lý" → "Sẵn sàng" (kết hợp T01-09); offline giữa chừng với file 20 MB (giới hạn băng thông bằng `page.route` throttle) |

## 8. Analytics / observability

- EV-03 `document_upload_started` `{document_id, file_size_mb (1 chữ số thập phân), batch_size: 1}`: phát khi nhận 201 (đề xuất, xem OQ-107 ở T01-04).
- EV-04 `document_upload_rejected` `{reason}`: `not_pdf`, `too_large` khi bị chặn phía client hoặc nhận 415/413; `duplicate_cancelled` khi bấm Huỷ. `too_many_pages` không phát được ở client (OQ-114).
- Không gửi tên file vào analytics.

## 9. Tham chiếu

SAD §4.1 (Tải lên), §8.2, §10.2; Blueprint §3.2.2 (`UploadItemVM`), §3.5.2, §3.5.3, §3.6.2, §3.7.2; prototype `workspace.html` (`#dropzone`, `#file-input`), `assets/workspace.js` (`handleFiles`, `runUpload`, `finishUpload`); PRD EC-04, EC-08, EC-11; USER_STORIES US-002.

## 10. Giả định và câu hỏi mở

- Giả định: Nginx/API chấp nhận upload chạy lâu (file 50 MB qua mạng chậm). `proxy_request_buffering` và timeout cho `/api/v1/documents` cấu hình ở T00-07/T02-08.
- Thử lại sẽ gửi lại toàn bộ file. Không có tải lên tiếp tục (resumable) trong MVP.
- **OQ-114:** EV-04 có `reason=too_many_pages` nhưng client không biết số trang trước khi tải. Đề xuất bỏ giá trị này khỏi EV-04 (lỗi quá số trang được ghi qua EV-06 ở server, T02-08), hoặc chấp nhận rằng client không bao giờ phát nó.
