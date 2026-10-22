# T04-02 — FE: SourceViewer pdf.js, nhảy trang, tô sáng

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S4 (21/12/2026 – 01/01/2027) |
| Story / WP | US-016 · WP-40 |
| Loại | FE |
| Ước lượng | 4 ngày công |
| Phụ thuộc | [T04-01](T04-01-document-file-range-api.md), [T02-07](T02-07-fe-answer-citations.md) (`CitationChip`, `SourceList`) |
| Chặn | — (được kiểm thử lại ở [T07-04](T07-04-final-regression.md)) |
| Trạng thái | Todo |

## 1. Mục tiêu

Bấm chip `[n]` (hoặc một dòng trong danh sách nguồn) mở vùng "Xem tài liệu" tại đúng trang được trích dẫn trong ≤ 2 s, tô sáng `cited_text`, không làm mất hội thoại; xử lý tài liệu đã gỡ, lỗi tải và màn hình 768–1279px.

## 2. Bối cảnh

- Blueprint §3.1.2 (`features/viewer`, nạp lười `pdfjs-dist`), §3.6.2 (`SourceViewer` props `viewer: ViewerVM`, `mode: "panel" | "overlay"`, sự kiện `onClose`, `onPageChange`), §3.7.3 (máy trạng thái `Closed → Loading → Loaded | Error | Removed`), §3.8 (bộ nhớ ≤ 300 MB, render trang hiện tại ± 1, cache ≤ 10 trang, pdf.js ~350 KB gzip nạp lười), UXD-01, UXD-11.
- Prototype: `workspace.html` (`#viewer`, `.viewer-head/body/foot`), `assets/workspace.js` hàm `openViewer`, `renderViewer`, `closeViewer` (Esc đóng, nút trước/sau, trạng thái removed/error); `components.css` `.workspace.viewer-open`, `@media` 768–1279 `.viewer { position: fixed; inset: var(--header-height) 0 0 0 }`.
- SAD §4.1: pdf.js tải `/api/v1/documents/{id}/file` bằng Range; tô sáng bằng tìm `cited_text` trên text layer. CSP `worker-src 'self' blob:` (§11.1).
- Quy tắc phụ thuộc UI: `features/chat` không import `features/viewer`; giao tiếp qua store Zustand trong `lib/state`.

## 3. Phạm vi

**Trong phạm vi:** `features/viewer/*`; `lib/state/viewerStore.ts`; nối `CitationChip`/`SourceList` gọi store; panel/overlay; tô sáng; điều hướng trang; trạng thái lỗi/đã gỡ; EV-12, EV-13; test.

**Ngoài phạm vi:** API file ([T04-01](T04-01-document-file-range-api.md)); nhãn "Tài liệu đã bị gỡ" trên chip và cập nhật khi người dùng tự gỡ trong phiên ([T05-04](T05-04-fe-document-removal.md)); zoom tự do, tìm kiếm trong PDF, in/tải xuống (sau MVP).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Nội dung |
|---|---|
| `frontend/src/lib/state/viewerStore.ts` | `{ open, documentId, documentTitle, page, pageStart, pageEnd, citedText, citeKey, status: "closed"\|"loading"\|"loaded"\|"error"\|"removed", openedAt }`; action `openCitation(c: CitationVM, ctx)`, `setPage(n)`, `close()`, `retry()` |
| `frontend/src/features/viewer/SourceViewer.tsx` | Khung: tiêu đề (tên file + "Trang X / N"), nút đóng (Esc), thân, chân (◀ trang ▶); `React.lazy` import phần pdf |
| `frontend/src/features/viewer/pdf/loadPdfjs.ts` | `await import("pdfjs-dist")`; `GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString()` |
| `frontend/src/features/viewer/pdf/usePdfDocument.ts` | `getDocument({ url, withCredentials: true, disableAutoFetch: true, disableStream: false, rangeChunkSize: 65536 })`; giữ tối đa 2 `PDFDocumentProxy` (LRU), `destroy()` khi bị đẩy ra |
| `frontend/src/features/viewer/pdf/PdfPage.tsx` | Render canvas (fit width theo `--viewer-width` hoặc bề rộng overlay, `devicePixelRatio`) + `TextLayer` của pdf.js 4; chỉ mount trang hiện tại ± 1; cache bitmap ≤ 10 trang |
| `frontend/src/features/viewer/highlight/findCitedText.ts` | Hàm thuần: chuẩn hoá và tìm `cited_text` trong text content; trả danh sách `(itemIndex, start, end)` |
| `frontend/src/features/viewer/useViewerLayout.ts` | `matchMedia("(min-width: 1280px)")` → `panel`, ngược lại `overlay` |
| `frontend/src/features/chat/CitationChip.tsx`, `SourceList.tsx` | `onClick` → `viewerStore.openCitation(...)` + EV-12; `aria-pressed` khi `citeKey` khớp |

### 4.2 Luồng mở

1. Bấm chip: phát EV-12 `{conversation_id, turn_index, citation_index, document_id, page: page_start}`; `openCitation` ghi `openedAt = performance.now()`.
2. Nếu `citation.document_removed === true` (từ API conversation hoặc store gỡ của T05-04) → `status = "removed"`, **không** gọi mạng (AC-US016-4).
3. Ngược lại `status = "loading"`, skeleton; nạp pdf.js (lần đầu), `getDocument`, `getPage(pageStart)`, render.
4. Trang render xong → `status = "loaded"`; chạy tô sáng; phát EV-13 `{document_id, load_ms, highlight_found}`.
5. Lỗi: `ResponseException.status === 410` → `removed`; mọi lỗi khác (mạng, 503, PDF hỏng) → `error` với "Không tải được tài liệu" + nút "Thử lại" (`retry()` huỷ proxy cũ, nạp lại) — AC-US016-5, EC-23.
6. Bấm chip khác khi panel đang mở → giữ panel, chuyển `loading` cho tài liệu/trang mới (Blueprint §3.7.3). Cùng tài liệu → dùng lại proxy, chỉ đổi trang.

### 4.3 Tô sáng

- Chuẩn hoá cả hai phía: Unicode NFC, gộp khoảng trắng, bỏ gạch nối cuối dòng (`-\n`), bỏ ký tự điều khiển; so khớp không phân biệt hoa thường.
- Ghép `textContent.items` của `page_start..page_end` thành chuỗi, ghi bảng ánh xạ offset → item. Tìm chính xác; không thấy → thử 80 ký tự đầu của `cited_text`; vẫn không thấy → `highlight_found = false`, hiển thị ghi chú nhỏ "Không xác định được vị trí đoạn trích trên trang này." (đề xuất).
- Đánh dấu bằng `<mark class="viewer-hl">` (nền `--color-highlight`) trong text layer; cuộn mark đầu tiên vào giữa vùng xem; nếu mark nằm ở `page_end` thì chuyển trang đó.
- Chuyển trang thủ công → xoá tô sáng (giống prototype).

### 4.4 Bố cục

| Bề rộng | Chế độ | Hành vi |
|---|---|---|
| ≥ 1280px | `panel` | Lưới `var(--sidebar-width) 1fr var(--viewer-width)`; hội thoại thu hẹp, không chuyển trang (UX-04) |
| 768–1279px | `overlay` | `position: fixed` dưới header, toàn màn; `role="dialog" aria-modal="true"`, bẫy focus, Esc đóng, trả focus về chip (AC-US016-6) |

`ChatThread` và `QuestionComposer` luôn được mount; viewer là phần tử anh em, đóng/mở không unmount hội thoại, không đụng bản nháp (AC-US016-3).

### 4.5 Accessibility và hiệu năng

- `<section aria-label="Xem tài liệu nguồn">`; `aria-live="polite"` thông báo "Trang 12 / 40"; nút ◀ ▶ có `aria-label`, vô hiệu ở đầu/cuối; phím `PageUp/PageDown` khi focus trong thân.
- Text layer chọn/sao chép được; tương phản mark ≥ 3:1 với chữ (token đã kiểm).
- Ngân sách: pdf.js không nằm trong bundle đầu (kiểm tra bằng `vite build --report`); bộ nhớ tab ≤ 300 MB với PDF 500 trang.

## 5. Các bước thực hiện

- [ ] Tạo `viewerStore` + test; nối chip/source list (thay thế placeholder T02-07).
- [ ] Tích hợp pdf.js lười; xác nhận worker chạy dưới CSP staging (`worker-src 'self' blob:`).
- [ ] `PdfPage` canvas + text layer; điều hướng trang; cache.
- [ ] `findCitedText` + unit test với fixture text content thật trích từ 5 PDF mẫu (T00-09).
- [ ] Panel/overlay, bẫy focus, Esc.
- [ ] Trạng thái removed/error/retry; MSW handler cho 206/410/503.
- [ ] Phát EV-12, EV-13 qua `lib/analytics` (schema đã khai ở T01-10; bổ sung nếu thiếu).
- [ ] Playwright + axe; đo thời gian mở trên staging.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US016-1:** bấm `[n]` → vùng xem mở bên phải tại `page_start`; p90 thời gian click → trang render ≤ 2 s trên staging với PDF 50 MB/500 trang (đo bằng `load_ms` của EV-13 trên 20 lần mở).
- [ ] **AC-US016-2:** khi `cited_text` tìm được, đoạn được tô sáng và cuộn vào tầm nhìn; tỷ lệ `highlight_found = true` ≥ 80% trên các trích dẫn của golden set (đề xuất).
- [ ] **AC-US016-3:** đóng viewer hoặc chuyển trang không làm mất tin nhắn, cuộn, bản nháp; gửi tiếp câu hỏi được ngay.
- [ ] **AC-US016-4:** trích dẫn tài liệu đã gỡ (cờ `document_removed` hoặc 410) hiển thị "Tài liệu đã bị gỡ", không mở tài liệu.
- [ ] **AC-US016-5:** lỗi tải (503/mạng) hiển thị "Không tải được tài liệu" + "Thử lại"; Thử lại thành công khi dịch vụ phục hồi.
- [ ] **AC-US016-6:** ở 768–1279px viewer mở dạng lớp phủ toàn màn, Esc/nút đóng trả về hội thoại.
- [ ] pdf.js không có trong bundle khởi tạo; axe-core không có lỗi serious/critical trên viewer.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit (Vitest) | `findCitedText`: khớp chính xác; khác khoảng trắng; xuống dòng có gạch nối; trải 2 trang; chuỗi tiếng Việt NFD vs NFC; không khớp → fallback 80 ký tự; `viewerStore` chuyển trạng thái đúng Blueprint §3.7.3 |
| Component (Testing Library + MSW) | Mở → loading → loaded; 410 → removed; 503 → error → retry → loaded; bấm chip khác giữ panel; `aria-pressed` |
| E2E (Playwright, `FakeLLMAdapter`) | J1: hỏi → bấm `[1]` → thấy "Trang 12" và `mark` hiển thị; viewport 1024×768 → overlay, Esc → focus về chip; gỡ tài liệu bằng API rồi bấm chip → "Tài liệu đã bị gỡ"; chặn route file → lỗi + Thử lại |
| Hiệu năng (staging) | Script Playwright mở 20 trích dẫn ngẫu nhiên, thu `load_ms` → p50/p90 trong báo cáo PR |

## 8. Analytics / observability

- EV-12 `citation_clicked` (P0) và EV-13 `source_viewer_loaded` (P1) theo PRD §6.2; không gửi `cited_text` hay tên file.
- `load_ms` đo từ click tới khi canvas trang đầu render xong (không tính tô sáng).

## 9. Tham chiếu

Blueprint §3.1.2, §3.4 UF-03, §3.6.2, §3.7.3, §3.8, §5 UXD-01, UXD-11; prototype `workspace.html`, `assets/workspace.js` (openViewer/renderViewer), `assets/components.css` (`.viewer*`, media query); SAD §4.1, §8.1, §10.2, §11.1 CSP; PRD UX-04, UX-11, EC-16, EC-23.

## 10. Giả định và câu hỏi mở

- Giả định: `CitationVM` từ T02-07 có `idx, documentId, documentTitle, pageStart, pageEnd, citedText, documentRemoved`.
- Giả định: tên tài liệu trong tiêu đề lấy từ `document_title` của citation (bản sao, INV-03), không gọi thêm API.
- **OQ-T0402-01:** Ngưỡng tỷ lệ tô sáng thành công (80%) là đề xuất; PO chốt hoặc bỏ khỏi tiêu chí.
- **OQ-T0402-02:** Có cần nút "Mở trong tab mới" (tải file đầy đủ) không? Chưa có trong PRD; mặc định không làm.
