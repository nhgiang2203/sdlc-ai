# T06-07 — Sao chép câu trả lời kèm nguồn

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-022 · WP-65 — **chỉ làm khi PO chấp thuận OQ-035** (hạn 18/01/2027) |
| Loại | FE |
| Ước lượng | 1 ngày công |
| Phụ thuộc | [T02-07](T02-07-fe-answer-citations.md) (`AnswerMessage`, `CitationChip`, `SourceList`); quyết định OQ-035 |
| Chặn | [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo (chờ OQ-035) |

## 1. Mục tiêu

Thêm nút "Sao chép" vào thanh hành động của câu trả lời đã hoàn tất: ghi vào clipboard câu trả lời dạng văn bản thuần kèm danh sách nguồn "[n] Tên tài liệu — trang X", hiển thị thông báo "Đã sao chép", phát EV-18. Nút không xuất hiện với câu trả lời "Không tìm thấy".

## 2. Bối cảnh

- US-022 (P2) từ UX-09 của PRD, phục vụ hành trình J1 (dán vào email/tài liệu gửi khách hàng). Story **không có BR nguồn** → cần PO chấp thuận (DoR, USER_STORIES §10; OQ-035).
- Ứng viên cắt **đầu tiên** của S6 (IMPLEMENTATION_PLAN §4 S6). Nếu OQ-035 bị từ chối hoặc chưa trả lời ngày 18/01 → task chuyển `Cancelled`, ẩn nút bằng cờ.
- Ghi chú kỹ thuật: Clipboard API phía client, không cần backend. Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js) (`data-act="copy"`, nối `innerText` + "Nguồn:", toast "Đã sao chép câu trả lời kèm nguồn", toast lỗi "Không sao chép được — trình duyệt chặn clipboard"); Blueprint §3.7.1 (Answered/Partial có "Sao chép").
- Liên quan BRU-006: người dùng chịu trách nhiệm kiểm chứng trước khi dùng cho cam kết với khách hàng — văn bản sao chép giữ số trang để người nhận kiểm chứng được.

## 3. Phạm vi

**Trong phạm vi:** hàm dựng văn bản thuần `buildCopyText`, nút `CopyAnswerButton`, xử lý lỗi clipboard, toast, cờ `FEATURE_COPY_ANSWER`, EV-18, test.

**Ngoài phạm vi:** sao chép định dạng HTML/rich text (đề xuất sau MVP: thêm `text/html` qua `ClipboardItem`); sao chép cả hội thoại; dòng nhắc BRU-006 tự động chèn vào văn bản sao chép (xem OQ-172); backend (không cần).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/features/chat/answer/buildCopyText.ts` | Hàm thuần `buildCopyText(message: MessageVM): string` |
| `frontend/src/features/chat/answer/CopyAnswerButton.tsx` | `Button` ghost cỡ sm, icon `copy`, nhãn "Sao chép", `aria-label="Sao chép câu trả lời kèm nguồn"` |
| `frontend/src/lib/clipboard.ts` | `writeText(text): Promise<void>` — `navigator.clipboard.writeText`; dự phòng `document.execCommand("copy")` qua textarea ẩn khi API không có (đề xuất) |
| `frontend/src/features/chat/answer/AnswerMessage.tsx` | Render nút trước 👍/👎, ngăn cách bằng `divider` như prototype |
| `frontend/src/lib/config/features.ts` | `FEATURE_COPY_ANSWER` (mặc định `false` tới khi OQ-035 được chấp thuận) |

### 4.2 Điều kiện hiển thị

| State `AnswerMessage` (Blueprint §3.7.1) | Nút "Sao chép" |
|---|---|
| Submitting, Retrieving, Streaming | Không hiển thị |
| Answered, Partial | Hiển thị |
| NotFound | **Không hiển thị** (AC-US022-2) |
| Stopped, Failed | Không hiển thị (đề xuất — câu trả lời chưa hoàn chỉnh) |

### 4.3 Định dạng văn bản

Nguồn dữ liệu: `message.text` (markdown hạn chế) + `message.citations` (sự kiện `citation` / `GET /conversations/{id}`), **không** đọc `innerText` của DOM như prototype (tránh lẫn nhãn nút, phụ thuộc layout).

1. Chuyển markdown → văn bản thuần bằng cùng parser `react-markdown`/`remark` (đề xuất `mdast-util-to-string` theo từng khối): đoạn cách nhau 1 dòng trống; danh sách giữ "- " hoặc "1. "; **đậm/nghiêng bỏ ký hiệu**; bảng → mỗi hàng một dòng, ô cách nhau " | ".
2. Chèn marker `[n]` đúng vị trí chip trích dẫn (vị trí lấy từ cùng mô hình dựng chip của T02-07).
3. Thêm khối nguồn, mỗi chỉ số một dòng, theo thứ tự `idx`, gộp trùng:

```text
Thanh toán 30% khi ký hợp đồng [1], 70% sau nghiệm thu trong 15 ngày [2].

Nguồn:
[1] HopDong_PhuHung_v2_DaKy.pdf — trang 12
[2] HopDong_PhuHung_v2_DaKy.pdf — trang 13–14
```

- Trang: `page_start == page_end` → "trang X"; khác → "trang X–Y" (gạch nối en dash).
- Tên tài liệu = `document_title` (snapshot, INV-03). Tài liệu đã gỡ → "[n] Tên — trang X (tài liệu đã bị gỡ)" (đề xuất).
- Partial không có trích dẫn nào → không có khối "Nguồn:"; thêm dòng "Câu trả lời không có nguồn trích dẫn — hãy kiểm chứng trước khi sử dụng." (Blueprint §3.6.4, đề xuất).
- Ký tự xuống dòng `\n` (Windows clipboard tự chuẩn hoá khi dán vào Outlook/Word — kiểm tra thủ công).

### 4.4 Phản hồi người dùng

- Thành công: `Toast` success "Đã sao chép" (AC-US022-1; prototype dùng "Đã sao chép câu trả lời kèm nguồn" — chọn văn bản theo AC); nhãn nút đổi thành "Đã sao chép" 2 s, `aria-live="polite"`.
- Thất bại (quyền bị chặn, không có focus): `Toast` danger "Không sao chép được — trình duyệt chặn clipboard", không phát EV-18.

## 5. Các bước thực hiện

- [ ] Xác nhận OQ-035 với PO (ngày 18/01/2027); nếu từ chối → đóng task, ghi lịch sử thay đổi phạm vi (IMPLEMENTATION_PLAN §5.3.4).
- [ ] `buildCopyText` + unit test bảng ví dụ.
- [ ] `lib/clipboard.ts` + dự phòng.
- [ ] `CopyAnswerButton`, tích hợp `AnswerMessage`, cờ tính năng.
- [ ] EV-18.
- [ ] Playwright (cấp quyền `clipboard-read`, `clipboard-write` cho Chromium) + axe.
- [ ] Kiểm tra thủ công dán vào Outlook, Word, Teams trên Edge/Chrome Windows.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US022-1:** câu trả lời Answered có 2 trích dẫn, bấm "Sao chép" → `navigator.clipboard.readText()` trả đúng văn bản thuần (không ký hiệu markdown) + "Nguồn:" + "[1] … — trang X", "[2] …"; toast "Đã sao chép" hiển thị.
- [ ] **AC-US022-2:** câu trả lời "Không tìm thấy" không có nút "Sao chép" trong DOM.
- [ ] Không có nút khi đang streaming, Stopped, Failed.
- [ ] EV-18 ghi nhận trên staging với `conversation_id`, `turn_index`.
- [ ] Nút dùng được bằng bàn phím (Tab, Enter/Space), axe 0 lỗi serious/critical.

## 7. Kiểm thử

| Tầng | Ca |
|---|---|
| Vitest `buildCopyText` | 1 trang / dải trang; trùng chỉ số; danh sách, bảng, đậm; tài liệu đã gỡ; Partial không trích dẫn; tiếng Anh (US-015) — tiêu đề khối vẫn "Nguồn:" (đề xuất) |
| Testing Library | Hiện/ẩn theo state; lỗi clipboard → toast danger, không gọi `track` |
| Playwright | AC-US022-1/2 trên Chromium; Edge chạy thủ công |

## 8. Analytics / observability

- EV-18 `answer_copied` (client, `lib/analytics`), `props: {conversation_id, turn_index}`; chỉ phát khi ghi clipboard thành công. Không gửi nội dung đã sao chép.
- Không có metric backend.

## 9. Tham chiếu

- USER_STORIES US-022, §10 DoR (truy vết BR hoặc PO chấp thuận), §11 OQ-035; PRD §5.1 UX-09, §6.2 EV-18 (PRD ghi P1).
- Blueprint §3.6.2 `AnswerMessage` (`onCopy`), §3.6.4, §3.7.1; prototype `workspace.js`.
- IMPLEMENTATION_PLAN §4 S6 WP-65, §5.1 OQ-035, §5.3.

## 10. Giả định và câu hỏi mở

- Giả định: ứng dụng chạy HTTPS (secure context) nên Clipboard API khả dụng trên Chrome/Edge (NFR-007).
- OQ-035 (kế thừa): PO chấp thuận US-022 vào MVP.
- **OQ-172 (mới):** Có chèn câu nhắc BRU-006 ("Thông tin cần kiểm chứng tại tài liệu gốc trước khi cam kết với khách hàng") vào cuối văn bản sao chép không? Owner: Trưởng nhóm BD.
- Ghi chú: PRD §6.2 xếp EV-18 là P1 trong khi story là P2. LG-08 chỉ yêu cầu 100% sự kiện **P0**, nên cắt US-022 không ảnh hưởng LG-08; khi cắt, đánh dấu EV-18 "không áp dụng" trong danh mục sự kiện của T01-10.
