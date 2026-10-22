# T05-04 — FE: gỡ tài liệu, xác nhận, trích dẫn tài liệu đã gỡ

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-005 · WP-51 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T05-03](T05-03-document-removal-api.md); liên quan [T02-09](T02-09-fe-document-errors.md) ("Xoá khỏi danh sách"), [T04-02](T04-02-fe-source-viewer.md) (trạng thái `removed` của viewer), [T04-04](T04-04-fe-scope-selection.md) (`scopeStore.prune`) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Người dùng gỡ một tài liệu qua hộp thoại xác nhận có tên tài liệu; tài liệu biến mất khỏi danh sách ngay; huỷ thì không có thay đổi; trích dẫn tới tài liệu đã gỡ (trong hội thoại đang mở hoặc hội thoại cũ) gắn nhãn "Tài liệu đã bị gỡ", gạch ngang và không mở được tài liệu.

## 2. Bối cảnh

- PRD UX-10, EC-16, EC-17, EC-22; Blueprint §3.4 UF-05 (lọc → "Gỡ" → xác nhận → toast "Đã gỡ"; lỗi: đã bị người khác gỡ → thông báo; lỗi mạng → toast lỗi + thử lại), §3.6.2 `ConfirmDialog` (`title`, `body`, `confirmLabel`, `tone: "danger"`, trạng thái `submitting`), `CitationChip` trạng thái `removed`, §3.6.4 mẫu câu "Xác nhận gỡ", UXD-06.
- Prototype `assets/workspace.js`: nút `data-act="remove"` (biểu tượng `trash`, `aria-label="Gỡ {tên}"`, vô hiệu khi `PROCESSING`), `confirmDialog(...)`, `removeDoc()` (bỏ khỏi danh sách, bỏ khỏi lựa chọn, viewer → `removed`, render lại chip); `components.css` `.cite.is-removed` (gạch ngang), `.source-item.is-removed`.

## 3. Phạm vi

**Trong phạm vi:** nút "Gỡ" trên `DocumentRow` cho tài liệu `READY` (và hợp nhất "Xoá khỏi danh sách" của `FAILED` vào cùng mutation); `ConfirmDialog`; mutation + xử lý lỗi; cập nhật cache danh sách, phạm vi, viewer; hiển thị trích dẫn đã gỡ từ `document_removed` và từ thao tác trong phiên; test.

**Ngoài phạm vi:** API và purge ([T05-03](T05-03-document-removal-api.md)); viewer hiển thị "Tài liệu đã bị gỡ" khi bấm chip ([T04-02](T04-02-fe-source-viewer.md) — task này chỉ cung cấp cờ); danh sách hội thoại cũ ([T06-06](T06-06-conversation-history-retention.md)).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Nội dung |
|---|---|
| `frontend/src/design-system/ConfirmDialog.tsx` | Radix `AlertDialog`; nút huỷ nhận focus mặc định (đề xuất cho thao tác phá huỷ); `submitting` vô hiệu cả hai nút + spinner trên nút xác nhận; Esc = Huỷ |
| `frontend/src/features/documents/useRemoveDocument.ts` | `useMutation` gọi `DELETE /api/v1/documents/{id}` (kèm `X-CSRF-Token` qua `lib/api`) |
| `frontend/src/features/documents/DocumentRow.tsx` | Nút `IconButton` "Gỡ tài liệu" |
| `frontend/src/lib/state/removedDocumentsStore.ts` | `removedIds: Set<string>`, `markRemoved(id)` — dùng chung cho `features/chat` và `features/viewer` |
| `frontend/src/features/chat/CitationChip.tsx`, `SourceList.tsx` | Trạng thái `removed` |

### 4.2 Nút và hộp thoại

| Trạng thái tài liệu | Nút | Hộp thoại |
|---|---|---|
| `READY` | "Gỡ tài liệu" (`aria-label="Gỡ {tên}"`) | Tiêu đề "Gỡ tài liệu?"; thân "“{tên}” sẽ không còn được dùng để trả lời. Thao tác này không hoàn tác được."; nút "Gỡ tài liệu" (danger) / "Huỷ" |
| `FAILED` | "Xoá khỏi danh sách" (T02-09) | "Xoá khỏi danh sách?"; "“{tên}” không xử lý được và sẽ bị xoá khỏi danh sách."; "Xoá" / "Huỷ" |
| `QUEUED`, `PROCESSING` | Vô hiệu, `title="Chờ xử lý xong để gỡ"` (như prototype) | — |

Tên tài liệu hiển thị đầy đủ trong thân (ngắt dòng, không cắt), là văn bản thuần (React escape).

### 4.3 Xử lý kết quả

| Kết quả | Hành vi |
|---|---|
| 204 | Đóng hộp thoại; bỏ tài liệu khỏi cache `["documents"]` (`setQueryData`) rồi `invalidateQueries`; `removedDocumentsStore.markRemoved(id)`; `scopeStore.prune`; nếu viewer đang mở tài liệu này → `viewerStore` chuyển `removed`; toast success "Đã gỡ {tên}" |
| 409 `ALREADY_REMOVED` hoặc 404 | Như 204 về dữ liệu; toast warning "Tài liệu đã được gỡ trước đó" (EC-22) |
| Lỗi mạng / 5xx | Giữ hộp thoại mở, hết `submitting`; thông báo lỗi trong hộp thoại "Không gỡ được tài liệu. Vui lòng thử lại." + nút xác nhận đóng vai "Thử lại"; tài liệu vẫn trong danh sách |
| Huỷ / Esc / bấm ngoài | Không gọi API, không thay đổi gì (AC-US005-5) |

Không dùng cập nhật lạc quan trước khi có phản hồi (tránh hiện lại tài liệu nếu lỗi).

### 4.4 Trích dẫn đã gỡ

- Một citation là "đã gỡ" khi `citation.document_removed === true` (API hội thoại, T05-03) **hoặc** `removedIds.has(citation.documentId)`.
- `CitationChip` removed: class `is-removed` (gạch ngang, màu `--color-text-muted`), `aria-label="Nguồn {n}: {tên}, {trang} (tài liệu đã bị gỡ)"`, tooltip "Tài liệu đã bị gỡ". Bấm vẫn gọi `viewerStore.openCitation` → viewer hiển thị "Tài liệu đã bị gỡ" không tải file (T04-02, AC-US016-4).
- `SourceList` removed: "[n] {tên} — Tài liệu đã bị gỡ · tr. X", `aria-disabled="true"`.
- Nội dung câu trả lời giữ nguyên (AC-US005-3).
- Người dùng khác gỡ: chip chỉ đổi khi tải lại hội thoại hoặc khi bấm (410 → viewer `removed` và `markRemoved`) — chấp nhận (không có push, ADR-011).

## 5. Các bước thực hiện

- [ ] `ConfirmDialog` trong design-system (nếu T00-10 chưa có) + story/test.
- [ ] `useRemoveDocument`; hợp nhất đường "Xoá khỏi danh sách" của T02-09.
- [ ] Nút trong `DocumentRow` theo bảng §4.2.
- [ ] `removedDocumentsStore`; cập nhật `CitationChip`, `SourceList`; nối với viewer và scope.
- [ ] MSW handler 204/409/500; Playwright + axe (hộp thoại).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US005-1:** chọn "Gỡ" trên tài liệu "Sẵn sàng", hộp thoại ghi đúng tên tài liệu, xác nhận → tài liệu biến mất khỏi danh sách và toast "Đã gỡ {tên}".
- [ ] **AC-US005-3:** mở lại hội thoại cũ (URL `/c/:id`) có trích dẫn tài liệu đã gỡ → câu trả lời hiển thị đủ, chip gạch ngang có nhãn "Tài liệu đã bị gỡ", bấm không mở tài liệu.
- [ ] **AC-US005-5:** bấm "Gỡ" rồi "Huỷ" (hoặc Esc) → không có request DELETE, danh sách không đổi.
- [ ] Hỗ trợ AC-US005-4: khi API trả 409, người dùng thấy "Tài liệu đã được gỡ trước đó" và tài liệu biến mất khỏi danh sách.
- [ ] Hộp thoại đạt WCAG: focus bị giữ trong hộp thoại, trả focus về hàng kế tiếp (hoặc ô lọc nếu danh sách rỗng) sau khi gỡ; axe không có lỗi serious/critical.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | Hàm `isCitationRemoved`; `removedDocumentsStore` |
| Component (MSW) | 204 → hàng biến mất + toast; 409 → toast cảnh báo; 500 → lỗi trong hộp thoại, Thử lại thành công; Huỷ không gọi API; nút vô hiệu khi `PROCESSING` |
| E2E (`FakeLLMAdapter`) | Hỏi có trích dẫn tài liệu A → gỡ A → chip A gạch ngang, bấm → viewer "Tài liệu đã bị gỡ"; tải lại trang `/c/:id` → vẫn gạch ngang (từ `document_removed`); hai tab cùng gỡ → tab 2 thấy "đã được gỡ trước đó" |
| Accessibility | axe trên hộp thoại mở; điều hướng bàn phím Tab/Shift+Tab/Esc |

## 8. Analytics / observability

- EV-07 do server ghi (T05-03); FE không phát trùng (khác prototype — prototype `track("document_removed")` phía client).
- Lỗi gỡ phía client chỉ ghi `request_id` trong toast/console để tra log, không gửi analytics.

## 9. Tham chiếu

USER_STORIES US-005; PRD UX-10, EC-16, EC-17, EC-22; Blueprint §3.4 UF-05, §3.6.2, §3.6.4, UXD-06; prototype `assets/workspace.js` (`confirmDialog`, `removeDoc`, `renderMessage`), `assets/components.css` (`.cite.is-removed`, `.source-item.is-removed`); SAD §8.3, §10.2.

## 10. Giả định và câu hỏi mở

- Giả định: `CitationVM.documentRemoved` đã có trong mapper của T02-07 (mặc định `false`).
- **OQ-T0504-01:** Focus mặc định trong hộp thoại phá huỷ đặt ở "Huỷ" (đề xuất) hay "Gỡ tài liệu" (prototype không nêu)?
- **OQ-T0504-02:** Có cần nút "Gỡ" trong trang chi tiết/tooltip ngoài hàng danh sách không? Không có trong nguồn; mặc định chỉ trên hàng.
