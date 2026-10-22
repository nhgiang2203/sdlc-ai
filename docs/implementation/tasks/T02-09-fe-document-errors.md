# T02-09 — FE: từ chối file phía client, lý do lỗi, xoá khỏi danh sách

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-004 · WP-23 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-08](T01-08-fe-upload-dropzone.md), [T01-09](T01-09-fe-document-sidebar.md), [T02-08](T02-08-ingestion-error-handling.md) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Hoàn thiện trải nghiệm "file không dùng được" ở cột kho tài liệu: thông báo từ chối rõ ràng trước khi tải lên (không phải PDF, quá 50 MB) và khi máy chủ trả 413/415; hiển thị lý do lỗi cụ thể cho tài liệu `FAILED` theo `error_reason`; nút "Xoá khỏi danh sách" có xác nhận gọi `DELETE /api/v1/documents/{id}`.

## 2. Bối cảnh

- [T01-08](T01-08-fe-upload-dropzone.md) đã có `validateFile` (đuôi, MIME, ≤ 50 MB), trạng thái `rejected` với badge "Không được chấp nhận" và EV-04; task này chuẩn hoá thông điệp theo AC, thêm xử lý 413/415 từ server và kiểm thử AC.
- [T01-09](T01-09-fe-document-sidebar.md) đã có `DocumentRow`, `StatusBadge` (biểu tượng + chữ, UX-07), polling 5 s.
- [T02-08](T02-08-ingestion-error-handling.md) cung cấp `error_reason`, 413/415 problem+json (kể cả từ Nginx), `DELETE` tài liệu `FAILED`.
- Prototype: `uploadBadge`, `renderSidebar`, nhánh `remove` với `confirmDialog` cho tài liệu `FAILED`, `errorText` trong [mock-data.js](../../design/UI_UX_design/assets/mock-data.js); CSS `.doc-error`, `.badge-failed`.

## 3. Phạm vi

**Trong phạm vi:**
- Bảng thông điệp từ chối/lỗi tập trung `features/documents/messages.ts`.
- Ánh xạ 413/415 từ server sang trạng thái `rejected` của mục tải lên.
- Dòng lý do lỗi `.doc-error` trên `DocumentRow` `FAILED`.
- Hành động "Xoá khỏi danh sách": `ConfirmDialog`, gọi `DELETE`, cập nhật cache, toast.

**Ngoài phạm vi:**
- "Gỡ tài liệu" cho tài liệu `READY` (hộp thoại "Gỡ tài liệu?", EV-07) → [T05-04](T05-04-fe-document-removal.md).
- Tải nhiều file, lớp phủ thả file toàn màn hình → [T06-05](T06-05-fe-multi-upload.md).
- Cảnh báo "X trang không đọc được văn bản" trong chi tiết tài liệu (EC-10) → đã ở [T01-09](T01-09-fe-document-sidebar.md).
- Kiểm số trang phía client: không làm (không nạp pdf.js ở luồng tải lên); số trang > 500 được báo qua `FAILED too_many_pages`.

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/features/documents/messages.ts` | `REJECT_TEXT`, `ERROR_REASON_TEXT`, `formatLimit()` |
| `frontend/src/features/documents/upload/validateFile.ts` | (T01-08) dùng `REJECT_TEXT` |
| `frontend/src/features/documents/upload/useUpload.ts` | Ánh xạ 413/415 → `rejected` |
| `frontend/src/features/documents/components/DocumentRow.tsx` | Dòng lý do lỗi, nút "Xoá khỏi danh sách" |
| `frontend/src/features/documents/api.ts` | `deleteFailedDocument(id)` |
| `frontend/src/lib/api/mocks/documents.ts` | MSW: `DELETE` 204/409, upload 413/415 |

### 4.2 Thông điệp

| Tình huống | Nguồn | Thông điệp (trong `.doc-error`) | EV-04 `reason` |
|---|---|---|---|
| Không phải PDF | Client (`validateFile`) hoặc server 415 | "Chỉ hỗ trợ file PDF." | `not_pdf` |
| > 50 MB | Client hoặc server 413 (`limit_bytes`) | "File vượt quá 50 MB." (giá trị lấy từ cấu hình `MAX_UPLOAD_MB`, server `limit_bytes` ưu tiên) | `too_large` |

| `error_reason` | Thông điệp (Blueprint §3.6.4 "{Lý do}. {Hành động}.") |
|---|---|
| `password_protected` | "File có mật khẩu. Hãy gỡ mật khẩu rồi tải lại." |
| `corrupted` | "File bị hỏng, không mở được. Hãy xuất lại PDF rồi tải lại." |
| `scanned` | "PDF dạng ảnh scan — chưa hỗ trợ. Hãy dùng bản PDF có chữ chọn được." |
| `too_many_pages` | "File vượt quá 500 trang." (đề xuất bổ sung hành động: "Hãy tách file rồi tải lại.") |
| `other` / giá trị lạ | "Lỗi xử lý, vui lòng thử tải lại." |

- AC dùng nhãn ngắn ("Có mật khẩu", "File bị hỏng"); badge vẫn là "Lỗi" (UX-07) và dòng lý do dùng câu đầy đủ ở trên — câu đầy đủ chứa ý của nhãn ngắn (xem §10).
- Khi từ chối, tên file vẫn hiển thị kèm nút ✕ "Bỏ qua" (T01-08); thông báo được đọc qua vùng `aria-live`.

### 4.3 Xoá khỏi danh sách

1. Nút biểu tượng thùng rác trên `DocumentRow` `FAILED`: `aria-label="Xoá {filename}"`, `title="Xoá khỏi danh sách"` (như prototype).
2. `ConfirmDialog` (tone `danger`): tiêu đề "Xoá khỏi danh sách?", thân "“{filename}” không xử lý được và sẽ bị xoá khỏi danh sách.", nút "Xoá" / "Huỷ"; focus mặc định vào "Huỷ" (đề xuất).
3. Xác nhận → `apiFetch(DELETE /api/v1/documents/{id})` → trạng thái `submitting` của dialog.
4. 204 → xoá khỏi cache query `documents` (optimistic sau khi thành công, không trước), đóng dialog, toast success "Đã xoá {filename}", trả focus về mục kế tiếp trong danh sách.
5. 409 `ALREADY_REMOVED` → coi như thành công (xoá khỏi danh sách) + toast info "Tài liệu đã được xoá trước đó". 404 → như 409. Lỗi khác/mạng → toast danger "Không xoá được. Vui lòng thử lại." + giữ nguyên dòng.

Nút xoá chỉ hiện cho `FAILED` trong S2; tài liệu `READY` có nút "Gỡ" ở T05-04; `PROCESSING` không có nút (prototype: `disabled`).

## 5. Các bước thực hiện

- [ ] Tạo `messages.ts`; cập nhật `validateFile`/`uploadBadge` của T01-08 dùng chung bảng thông điệp.
- [ ] Xử lý 413/415 trong `useUpload` (đọc `ApiError.code`, `extra.limit_bytes`), phát EV-04.
- [ ] Thêm dòng lý do lỗi vào `DocumentRow` (`ERROR_REASON_TEXT`).
- [ ] Thêm `deleteFailedDocument`, nút + `ConfirmDialog` + toast; cập nhật cache.
- [ ] MSW handler cho các kịch bản; Playwright với bộ file lỗi mẫu (DEP-002) trên staging.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US004-1:** chọn/thả file `.docx` hoặc `.png` → bị từ chối ngay, **không có request tải lên** (kiểm `page.on("request")`), hiển thị "Chỉ hỗ trợ file PDF."; file `.pdf` giả (đổi đuôi) qua được client nhưng server trả 415 → cùng thông điệp.
- [ ] **AC-US004-2:** file 51 MB bị từ chối trước khi tải với "File vượt quá 50 MB."; file vượt 500 trang hiển thị "Lỗi" + "File vượt quá 500 trang." sau khi xử lý (giới hạn số trang chỉ kiểm được ở server).
- [ ] **AC-US004-4:** tài liệu "Lỗi" → "Xoá khỏi danh sách" → xác nhận → tài liệu biến mất khỏi danh sách và không quay lại sau polling/tải lại trang.
- [ ] Tài liệu `FAILED` với `password_protected`, `corrupted`, `scanned` hiển thị đúng lý do ở bảng §4.2 (phần hiển thị của AC-US004-3; phân loại ở T02-08).
- [ ] `FAILED other` (sau 3 retry, AC-US004-5 ở T02-08) hiển thị "Lỗi xử lý, vui lòng thử tải lại."
- [ ] EV-04 phát đúng `reason` cho từ chối client và 413/415 server, không phát trùng.
- [ ] axe-core không lỗi nghiêm trọng; dialog bẫy focus và đóng bằng Esc.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `ERROR_REASON_TEXT` mọi giá trị + giá trị lạ; ánh xạ `ApiError` 413/415 → `rejected` |
| Component (MSW) | `DELETE` 204, 409, 500; huỷ dialog không gọi API; focus trở lại đúng chỗ |
| E2E (staging, bộ file lỗi mẫu `eval/corpus/invalid/`) | Từng file → trạng thái và lý do đúng; xoá khỏi danh sách |
| Accessibility | Badge "Lỗi" có biểu tượng + chữ; dòng lý do đọc được bởi trình đọc màn hình |

## 8. Analytics / observability

- EV-04 `document_upload_rejected` `{reason: not_pdf | too_large}` (client và khi nhận 413/415).
- EV-06 do worker ghi (T02-08), FE không gửi.
- Không phát EV-07 khi xoá tài liệu `FAILED` (EV-07 thuộc gỡ tài liệu, T05-04 — xem §10).

## 9. Tham chiếu

- [USER_STORIES.md — US-004](../../requirements/USER_STORIES.md)
- [Blueprint_Design.md](../../design/Blueprint_Design.md) §3.6.2 (`DocumentRow`, `ConfirmDialog`, `Toast`), §3.6.4, §3.7.2, §5 UXD-06, UXD-07
- [PRD.md](../../requirements/PRD.md) §5.2 EC-08, EC-09; §6.2 EV-04
- [SAD.md](../../requirements/SAD.md) §4.1 (tải lên), §9.1, §10.2
- Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js), [mock-data.js](../../design/UI_UX_design/assets/mock-data.js)

## 10. Giả định và câu hỏi mở

- Giả định `ConfirmDialog`, `Toast` có sẵn trong design system (T00-10).
- **OQ-T0209-1:** AC-US004-3 nêu nhãn ngắn ("Có mật khẩu" / "File bị hỏng" / "PDF dạng ảnh scan — chưa hỗ trợ"), prototype dùng câu đầy đủ có hành động. Đề xuất giữ câu đầy đủ; QA kiểm theo chuỗi con của nhãn ngắn. Cần PO xác nhận.
- **OQ-T0209-2:** Xoá tài liệu `FAILED` có cần hộp thoại xác nhận không? UXD-06 chỉ yêu cầu xác nhận cho thao tác phá huỷ; prototype có xác nhận. Đề xuất giữ.
- **OQ-T0209-3:** Có phát EV-07 `document_removed` khi xoá tài liệu `FAILED` không? Đề xuất không (EV-07 đo gỡ tài liệu đã dùng, RSK-007).
