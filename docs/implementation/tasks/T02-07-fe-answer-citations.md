# T02-07 — FE: hiển thị câu trả lời, chip trích dẫn, danh sách nguồn

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S2 (23/11 – 04/12/2026) |
| Story / WP | US-010 · WP-22 |
| Loại | FE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T02-06](T02-06-fe-chat-composer-stream.md) |
| Chặn | [T03-03](T03-03-fe-not-found-processing-note.md), [T04-02](T04-02-fe-source-viewer.md), [T06-03](T06-03-answer-feedback.md), [T06-07](T06-07-copy-answer.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hiển thị nội dung câu trả lời bằng Markdown hạn chế an toàn, chèn chip `[n]` ngay cạnh ý có trích dẫn (dựng từ sự kiện SSE `citation`, không parse từ text), danh sách nguồn cuối câu trả lời "[n] Tên tài liệu — trang X" / "trang 12–13", và cảnh báo khi câu trả lời `partial` không có nguồn. Áp dụng cho cả câu trả lời đang stream lẫn câu trả lời nạp lại từ `GET /conversations/{id}`.

## 2. Bối cảnh

- UXD-02: chip `[n]` cạnh ý + danh sách nguồn cuối; bấm được bằng bàn phím. ADR-006: chip dựng từ citation gốc của Claude.
- SAD §4.1: `react-markdown`, không HTML thô, DOMPurify; Blueprint §3.6.2: `AnswerMessage`, `CitationChip`, `SourceList`.
- Prototype: `renderText`, `renderMessage` trong [workspace.js](../../design/UI_UX_design/assets/workspace.js); CSS `.cite`, `.cite[aria-pressed]`, `.cite.is-removed`, `.sources`, `.source-item`, `.src-page`, `.callout-warning`.
- Dữ liệu: SSE `citation` (T02-05 §4.3) phát sau văn bản của khối; message nạp lại có `segments` + `citations` (T02-01 §4.4).

## 3. Phạm vi

**Trong phạm vi:** mô hình segments phía client, renderer Markdown + chip, `CitationChip`, `SourceList`, cảnh báo `partial`, chuyển `Message` API → VM, nhãn trang, aria.

**Ngoài phạm vi:**
- Mở `SourceViewer` khi bấm chip, EV-12, EV-13 → [T04-02](T04-02-fe-source-viewer.md). S2: bấm chip đánh dấu chip đang chọn và cuộn/nhấn mạnh mục tương ứng trong `SourceList` (đề xuất).
- Khối "Không tìm thấy" (ℹ️, không chip) → [T03-03](T03-03-fe-not-found-processing-note.md).
- Hiển thị "Tài liệu đã bị gỡ" (gạch ngang) → [T05-04](T05-04-fe-document-removal.md) (task này chỉ truyền `documentRemoved` vào VM và để sẵn class `.is-removed`).
- Nút Sao chép → [T06-07](T06-07-copy-answer.md); 👍/👎 → [T06-03](T06-03-answer-feedback.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/features/chat/model/segments.ts` | `appendDelta`, `attachCitation`, `fromApiMessage` |
| `frontend/src/features/chat/components/AnswerContent.tsx` | Renderer Markdown + chip |
| `frontend/src/features/chat/components/CitationChip.tsx` | Chip `[n]` |
| `frontend/src/features/chat/components/SourceList.tsx` | Danh sách nguồn |
| `frontend/src/features/chat/components/AnswerMessage.tsx` | Mở rộng khung của T02-06 cho `streaming`, `answered`, `partial`, `stopped`, `failed` |
| `frontend/src/features/chat/format/pageLabel.ts` | Nhãn trang |
| `frontend/src/lib/state/citationFocus.ts` | Store Zustand chip đang chọn (T04-02 dùng để mở viewer) |

### 4.2 Mô hình VM

```ts
interface CitationVM {
  idx: number; documentId: string; documentTitle: string;
  pageStart: number; pageEnd: number; citedText: string; documentRemoved: boolean;
}
interface SegmentVM { text: string; cites: number[] }
// MessageVM (T02-06) được thay trường text bằng:
//   segments: SegmentVM[]; citations: CitationVM[]   // citations: duy nhất theo idx, sắp theo idx
```

- Stream: `delta` → nối vào segment cuối; `citation` → thêm `idx` vào `cites` của segment cuối và (nếu `idx` mới) thêm vào `citations`; segment tiếp theo bắt đầu sau một citation hoặc khi T02-05 gửi khối mới (đề xuất: tách segment khi nhận `citation` rồi có `delta` tiếp).
- Nạp lại: `fromApiMessage(m)` dùng `m.segments` + `m.citations`; nếu thiếu `segments` (message cũ) → một segment `m.text`, chip chỉ ở `SourceList`.

### 4.3 Renderer Markdown + chip

- Ghép chuỗi Markdown: với mỗi segment, nối `text` rồi chèn token giữ chỗ `{n}` (ký tự vùng riêng) cho từng `idx` trong `cites`.
- `react-markdown` cấu hình: `skipHtml`, `allowedElements = ["p","ul","ol","li","strong","em","table","thead","tbody","tr","th","td","br","code"]`, `unwrapDisallowed`, không plugin `rehype-raw`; `remark-gfm` cho bảng. Liên kết (`a`) và ảnh bị loại (đề xuất: tránh liên kết lạ từ tài liệu).
- Component tuỳ biến cho node văn bản: tách token giữ chỗ → `<CitationChip idx={n} />`, giữ chip dính chữ trước bằng `white-space: nowrap` (như prototype `.nowrap`).
- DOMPurify: renderer không sinh HTML thô nên không qua `innerHTML`; DOMPurify chỉ áp cho mọi đường nào cần chuỗi HTML (ví dụ T06-07 sao chép rich text) — xem §10.
- Khi đang stream: render lại toàn bộ theo nhịp flush của T02-06 (≤ 1 lần / 50 ms); con trỏ `.cursor` ở cuối; Markdown dở dang (bảng chưa đóng) chấp nhận hiển thị tạm.

### 4.4 `CitationChip` và `SourceList`

| Thành phần | Hiển thị | Thuộc tính truy cập |
|---|---|---|
| `CitationChip` | `<button class="cite">n</button>`; `aria-pressed` khi đang chọn; `.is-removed` khi `documentRemoved` | `aria-label="Nguồn n: {documentTitle}, {pageLabel}"`; Tab tới được; Enter/Space kích hoạt |
| `SourceList` | Tiêu đề "Nguồn"; mỗi dòng: chip giả (`aria-hidden`), tên tài liệu, nhãn trang căn phải (`.src-page`) | Danh sách `<ol>`; mỗi mục là `<button>` cùng hành vi với chip |

- `pageLabel(c)`: `pageStart === pageEnd` → `trang {a}`; ngược lại `trang {a}–{b}` (dấu gạch nối en "–"). Chip/aria dùng "trang", khớp AC (prototype dùng "tr." — chọn "trang" theo AC-US010-1/3).
- Tên tài liệu dài: cắt bằng CSS ellipsis, `title` chứa tên đầy đủ.
- `SourceList` chỉ hiện khi có ≥ 1 citation và trạng thái ≠ `retrieving`.
- Bấm chip/mục nguồn (S2): đặt `citationFocus = {messageId, idx}` → chip `aria-pressed="true"`, mục nguồn tương ứng được highlight; T04-02 lắng nghe store này để mở viewer.

### 4.5 Cảnh báo và trạng thái

| Trạng thái | Phần thêm |
|---|---|
| `partial` | `.callout-warning` biểu tượng cảnh báo + "Câu trả lời không có nguồn trích dẫn — hãy kiểm chứng trước khi sử dụng." (Blueprint §3.6.4) khi `citations.length === 0`; nếu `partial` mà có citation (ví dụ `max_tokens`) → "Câu trả lời có thể chưa đầy đủ — hãy kiểm chứng." (đề xuất) |
| `stopped` | Nội dung + chip đã nhận + nhãn "Đã dừng" (T02-06) + `SourceList` của các citation đã nhận |
| `failed` | Nội dung đã nhận (nếu có, trừ `refused`) + `SourceList` đã nhận + khối lỗi (T02-06) |

## 5. Các bước thực hiện

- [ ] Viết `segments.ts` + unit test (stream và nạp lại).
- [ ] Viết `pageLabel.ts` + test.
- [ ] Viết `AnswerContent` với `react-markdown` + `remark-gfm`, bộ tách token chip.
- [ ] Viết `CitationChip`, `SourceList`, store `citationFocus`.
- [ ] Nối vào `AnswerMessage` cho các trạng thái §4.5; cập nhật MSW fixture từ `answers` trong [mock-data.js](../../design/UI_UX_design/assets/mock-data.js).
- [ ] Test XSS, accessibility, Playwright.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US010-1:** câu trả lời `answered` hiển thị chip `[n]` cạnh mỗi đoạn/ý có citation và danh sách nguồn "[n] Tên tài liệu — trang X" ở cuối; chip xuất hiện trong lúc stream khi sự kiện `citation` đến (E2E với Fake LLM mặc định).
- [ ] **AC-US010-3:** citation có `page_start=12, page_end=13` hiển thị "trang 12–13" ở chip `aria-label` và `SourceList` (`[fake:two_pages]`).
- [ ] Câu trả lời `partial` không có citation hiển thị cảnh báo "Câu trả lời không có nguồn trích dẫn — hãy kiểm chứng…" (phần hiển thị của AC-US010-4; logic ở [T02-05](T02-05-ask-question-sse.md)).
- [ ] Mở lại hội thoại (`/c/:id`) hiển thị chip đúng vị trí như lúc stream (so sánh snapshot DOM).
- [ ] Câu trả lời chứa `<script>`, `<img onerror>`, `[link](javascript:…)` hiển thị dạng văn bản, không thực thi (test XSS).
- [ ] Chip và mục nguồn thao tác được hoàn toàn bằng bàn phím; axe-core không lỗi nghiêm trọng; tương phản chip đạt token `--color-primary-strong` trên `--color-primary-soft`.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `appendDelta`/`attachCitation` (idx lặp, idx mới); `fromApiMessage` có/không `segments`; `pageLabel` |
| Component | Markdown: danh sách, đậm, bảng; chip trong đoạn và trong mục danh sách; token chip không bị Markdown hiểu sai (dấu `*` liền kề) |
| Bảo mật | Chuỗi XSS phổ biến (OWASP cheat sheet) trong `delta` |
| E2E | J1: chip xuất hiện, `SourceList` đúng thứ tự `idx`; `[fake:multi_doc]` có nguồn từ 2 tài liệu; `[fake:no_citation]` có cảnh báo |
| Accessibility | axe-core; điều hướng Tab qua chip; trình đọc màn hình đọc "Nguồn 1: HopDong_PhuHung_v2_DaKy.pdf, trang 12" |

## 8. Analytics / observability

- Không phát sự kiện mới trong S2. EV-12 `citation_clicked` phát ở [T04-02](T04-02-fe-source-viewer.md) khi bấm chip mở viewer.
- `citation_count`, `distinct_docs_cited` của EV-09 do server tính (T02-05); FE không gửi trùng.

## 9. Tham chiếu

- [USER_STORIES.md — US-010](../../requirements/USER_STORIES.md)
- [Blueprint_Design.md](../../design/Blueprint_Design.md) §3.6.2, §3.6.3 (token màu chip), §3.6.4, §3.7.1, §5 UXD-02
- [SAD.md](../../requirements/SAD.md) §4.1 (hiển thị câu trả lời), §10.2 (schema `Message`), §10.3, §11.1 (XSS), ADR-006
- [PRD.md](../../requirements/PRD.md) §5.1 UX-03
- Prototype [workspace.js](../../design/UI_UX_design/assets/workspace.js), [components.css](../../design/UI_UX_design/assets/components.css)

## 10. Giả định và câu hỏi mở

- Giả định T02-01 bổ sung `segments` vào schema `Message` (T02-01 OQ-1); nếu không, phải dựng vị trí chip từ `llm_content` phía server.
- **OQ-T0207-1:** SAD yêu cầu "kết quả đi qua DOMPurify" nhưng `react-markdown` với `skipHtml` không sinh HTML thô. Đề xuất ghi rõ trong SAD: DOMPurify chỉ áp cho đường xuất HTML (sao chép), còn hiển thị dùng whitelist phần tử của `react-markdown`.
- **OQ-T0207-2:** Văn bản cảnh báo: AC-US010-4 ghi "…— hãy kiểm chứng", Blueprint §3.6.4 ghi "…— hãy kiểm chứng trước khi sử dụng." Đề xuất dùng bản Blueprint (chứa nguyên văn AC).
- **OQ-T0207-3:** Có cho phép liên kết trong câu trả lời không? Đề xuất không (tránh dẫn tới URL lạ trích từ tài liệu).
