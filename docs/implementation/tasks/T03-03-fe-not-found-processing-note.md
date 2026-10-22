# T03-03 — FE: khối "Không tìm thấy", ghi chú tài liệu đang xử lý

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S3 (07/12 – 18/12/2026) |
| Story / WP | US-011, US-008 · WP-31, WP-34 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T02-07](T02-07-fe-answer-citations.md) (dữ liệu: `meta.docs_processing` từ [T02-05](T02-05-ask-question-sse.md), `not_found` từ [T03-02](T03-02-not-found-gate-calibration.md) — làm song song bằng MSW) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Hiển thị câu trả lời "Không tìm thấy" bằng kiểu riêng (khối thông tin ℹ️, không chip trích dẫn, không danh sách nguồn) kèm phạm vi đã tìm và gợi ý diễn đạt lại/thêm tài liệu (UXD-03, UX-08); hiển thị ghi chú "N tài liệu đang xử lý chưa được dùng để trả lời" dưới câu trả lời khi có tài liệu đang xử lý (EC-03, WP-34).

## 2. Bối cảnh

- UXD-03: người dùng không được nhầm "không có" với "có câu trả lời". Blueprint §3.7.1: trạng thái `NotFound` — khối màu info, biểu tượng ℹ️, không chip; hành động: gợi ý diễn đạt lại, 👍/👎.
- UX writing Blueprint §3.6.4: "Không tìm thấy thông tin này trong các tài liệu hiện có." + "Đã tìm trong {n} tài liệu." + gợi ý.
- Prototype: nhánh `m.state === "not_found"` và dòng `m.processing` trong `renderMessage` ([workspace.js](../../design/UI_UX_design/assets/workspace.js)); CSS `.callout.callout-info`, `.callout-title`.
- SSE `meta {docs_in_scope, docs_processing}` (T02-05); `done.answer_type = "not_found"` từ cổng hoặc câu cố định (T03-02).

## 3. Phạm vi

**Trong phạm vi:** trạng thái `not_found` của `AnswerMessage`, chuỗi i18n, ghi chú tài liệu đang xử lý, xử lý văn bản đã stream khi `done` là `not_found`, hiển thị khi mở lại hội thoại.

**Ngoài phạm vi:**
- Chọn phạm vi và "đã chọn" trong dòng phạm vi, ghi chú trên `ScopeBar` → [T04-04](T04-04-fe-scope-selection.md) (task này nhận sẵn prop `scopeType`).
- Chuỗi tiếng Anh → [T04-05](T04-05-english-language-support.md).
- 👍/👎 → [T06-03](T06-03-answer-feedback.md) (khối not_found để sẵn vùng `answer-actions`).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/features/chat/components/NotFoundBlock.tsx` | Khối info |
| `frontend/src/features/chat/components/ProcessingNote.tsx` | Ghi chú tài liệu đang xử lý |
| `frontend/src/features/chat/components/AnswerMessage.tsx` | Rẽ nhánh `not_found`; gắn `ProcessingNote` |
| `frontend/src/lib/i18n/answer.vi.ts` | `NOT_FOUND_TEXT`, `searchedIn(n, scoped)`, `NOT_FOUND_HINT`, `processingNote(n)` |
| `frontend/src/features/chat/model/answerMachine.ts` | Lưu `docsInScope`, `docsProcessing` từ `meta` (T02-06 đã có trường) |

### 4.2 `NotFoundBlock`

```tsx
<div className="callout callout-info" role="note" aria-labelledby={titleId}>
  <InfoIcon aria-hidden />                               {/* ℹ️ */}
  <div className="callout-body">
    <p className="callout-title" id={titleId}>Không tìm thấy thông tin này trong các tài liệu hiện có.</p>
    <p>Đã tìm trong {n} tài liệu{scopeType === "selected" ? " đã chọn" : ""}.
       Thử diễn đạt khác, kiểm tra phạm vi tài liệu, hoặc thêm tài liệu liên quan.</p>
  </div>
</div>
```

- `n` = `meta.docs_in_scope` (stream) hoặc giá trị lưu kèm message khi mở lại (§4.4).
- **Không** render `CitationChip`, `SourceList`, nút Sao chép; vẫn để chỗ cho `FeedbackControl` (prototype: chỉ 👍/👎).
- Khi `done.answer_type = "not_found"` đến sau khi đã stream văn bản (lớp 2, LLM trả câu cố định): thay văn bản đã stream bằng khối này (không hiển thị cả hai).
- Vùng `aria-live`: "Không tìm thấy thông tin này trong các tài liệu hiện có."
- Màu: token `--color-info` / `--color-info-soft`; khác rõ với `callout-warning` của `partial` và `callout-danger` của lỗi.

### 4.3 `ProcessingNote`

- Điều kiện: `docsProcessing > 0` và trạng thái ∈ {`answered`, `partial`, `not_found`, `stopped`} (không hiện khi `retrieving`/`failed`, như prototype).
- Văn bản: "{N} tài liệu đang xử lý chưa được dùng để trả lời." — `<p class="muted">` cỡ `--text-xs`, đặt sau nội dung/khối not_found, trước `SourceList`.
- Giá trị lấy tại thời điểm hỏi (`meta`), không cập nhật theo polling sau đó.

### 4.4 Mở lại hội thoại

- `GET /conversations/{id}` chưa trả `docs_in_scope`/`docs_processing` cho từng message. Đề xuất: T02-05 lưu hai giá trị trong `conv.messages.usage` (đã ghi trong T02-05 §4.4 bước 3) (`{"docs_in_scope": 12, "docs_processing": 2, …}`) và API `Message` trả thêm `docs_in_scope`, `docs_processing` (đề xuất, xem §10). Nếu không có: khối not_found bỏ câu "Đã tìm trong N tài liệu", không hiện `ProcessingNote`.

## 5. Các bước thực hiện

- [ ] Thêm chuỗi vào `lib/i18n/answer.vi.ts` (cấu trúc sẵn cho T04-05 thêm `answer.en.ts`).
- [ ] Viết `NotFoundBlock`, `ProcessingNote`; nối vào `AnswerMessage`.
- [ ] Xử lý chuyển văn bản đã stream → khối not_found khi `done` là `not_found`.
- [ ] MSW: kịch bản `not_found` từ cổng (không `delta`), `not_found` sau `delta`, `docs_processing = 2`.
- [ ] Test component, Playwright, axe-core.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US011-1:** câu hỏi không có thông tin trong kho → hiển thị "Không tìm thấy thông tin này trong các tài liệu hiện có." kèm "Đã tìm trong 12 tài liệu." (theo `docs_in_scope`) và gợi ý diễn đạt lại hoặc thêm tài liệu (E2E với corpus staging: câu "Thủ đô của Pháp là gì?").
- [ ] **AC-US011-3:** khối not_found không có chip trích dẫn, không có danh sách nguồn, kiểu hiển thị info với biểu tượng ℹ️ khác câu trả lời thường (kiểm DOM + snapshot thị giác).
- [ ] **AC-US008-8:** khi có 2 tài liệu đang xử lý lúc hỏi → dưới câu trả lời có "2 tài liệu đang xử lý chưa được dùng để trả lời." (EC-03).
- [ ] LLM trả câu cố định sau khi đã stream → chỉ còn khối not_found, không có cảnh báo "không có nguồn".
- [ ] axe-core không lỗi nghiêm trọng; trình đọc màn hình đọc tiêu đề khối.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Component (MSW) | not_found từ cổng; not_found sau delta; `docs_processing` 0 / 1 / 5; `failed` không hiện ghi chú |
| E2E | Corpus staging: câu ngoài kho → khối not_found; tải lên 1 PDF lớn rồi hỏi ngay → ghi chú đang xử lý |
| Thị giác | So khối not_found với `answered` và `partial` (Playwright screenshot, chế độ sáng/tối) |

## 8. Analytics / observability

- Không phát sự kiện mới; EV-09 `answer_type = not_found` do server ghi.
- Tỷ lệ not_found theo tuần hiển thị ở trang Thống kê (T06-01/T06-02).

## 9. Tham chiếu

- [USER_STORIES.md — US-011, US-008 (AC-US008-8)](../../requirements/USER_STORIES.md)
- [Blueprint_Design.md](../../design/Blueprint_Design.md) §3.6.2 (`AnswerMessage` states), §3.6.4, §3.7.1, §5 UXD-03
- [PRD.md](../../requirements/PRD.md) §5.1 UX-08, §5.2 EC-03, EC-14
- [SAD.md](../../requirements/SAD.md) §10.3 (`meta`), §9.2
- [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md) S3 WP-31, WP-34

## 10. Giả định và câu hỏi mở

- Giả định T02-06 đã lưu `docsInScope`, `docsProcessing` từ `meta` vào `MessageVM`.
- **OQ-T0303-1:** README ghi phụ thuộc chỉ T02-07, nhưng dữ liệu cần `meta.docs_processing` (T02-05) và `not_found` (T03-02). Đề xuất ghi thêm phụ thuộc mềm.
- **OQ-T0303-2:** Lưu `docs_in_scope`, `docs_processing` theo message để hiển thị khi mở lại hội thoại (§4.4) — chưa có trong SAD §7.2/§10.2. Cần Architect quyết định (đề xuất lưu trong `usage`).
- **OQ-T0303-3:** Ghi chú "N tài liệu đang xử lý" có cần hiện cả trên `ScopeBar` (Blueprint state `processing-note`) không? Đề xuất có, làm ở T04-04 khi có `ScopeBar`.
