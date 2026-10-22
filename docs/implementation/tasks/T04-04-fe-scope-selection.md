# T04-04 — FE: chọn tài liệu, thanh phạm vi

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S4 (21/12/2026 – 01/01/2027) |
| Story / WP | US-013 · WP-41 |
| Loại | FE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-09](T01-09-fe-document-sidebar.md) (`DocumentSidebar`, `DocumentRow`), [T04-03](T04-03-scope-filter-api.md) (hợp đồng `scope_document_ids`) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Người dùng tick chọn tài liệu trong cột kho để giới hạn phạm vi hỏi; thanh phạm vi ngay trên ô hỏi luôn cho biết đang hỏi trong bao nhiêu tài liệu; ô hỏi bị vô hiệu khi phạm vi chưa có tài liệu sẵn sàng.

## 2. Bối cảnh

- PRD UX-05; Blueprint UXD-05 (checkbox + thanh phạm vi, không có khái niệm "dự án"), §3.6.2 `DocumentSidebar` (`selectedIds`, `onToggleSelect`), `ScopeBar` (`scope: ScopeVM`, trạng thái `all`, `selected`, `none-ready`, `processing-note`, sự kiện `onClearScope`), `QuestionComposer` (`disabled`, `disabledReason`), §3.7.4.
- Prototype `assets/workspace.js`: `scopeIds()`, `renderScope()`, listener `change` trên `.checkbox`, nút "Hỏi trong tất cả"; `components.css` `.scope-bar`, `.doc-row.is-selected`.
- SAD §4.1: phạm vi đã chọn nằm trong Zustand (UI state).
- **Khác prototype:** prototype vô hiệu checkbox với tài liệu chưa READY và tự quay về "toàn kho" khi lựa chọn không còn tài liệu READY. Như vậy không bao giờ xảy ra AC-US013-4 (EC-18). Task này cho phép chọn tài liệu đang xử lý để thoả AC-US013-4 (xem §4.2, OQ-T0404-01).

## 3. Phạm vi

**Trong phạm vi:** `lib/state/scopeStore.ts`; checkbox trong `DocumentRow`; `ScopeBar`; truyền `scope_document_ids` khi hỏi; vô hiệu composer (EC-18); dọn lựa chọn khi tài liệu biến mất; EV-14; test.

**Ngoài phạm vi:** lọc phía server ([T04-03](T04-03-scope-filter-api.md)); dọn lựa chọn khi chính người dùng gỡ tài liệu (gọi `scopeStore.prune` ở [T05-04](T05-04-fe-document-removal.md)).

## 4. Thiết kế chi tiết

### 4.1 Store

`frontend/src/lib/state/scopeStore.ts` (Zustand, đồng bộ `sessionStorage` khoá `cwd.scope` — đề xuất giữ lựa chọn khi tải lại trang trong cùng tab):

```ts
type ScopeState = {
  selectedIds: Set<string>;
  toggle(id: string): void;
  clear(): void;
  prune(existingIds: Set<string>): void;   // gọi mỗi khi danh sách documents thay đổi
};
```

Selector thuần `deriveScope(selectedIds, documents) -> ScopeVM`:

```ts
type ScopeVM = {
  kind: "all" | "selected" | "none-ready" | "selected-not-ready";
  readyTotal: number;          // tổng tài liệu READY trong kho
  selectedCount: number;
  selectedReadyIds: string[];  // gửi lên API
  selectedProcessing: number;  // QUEUED/PROCESSING trong lựa chọn
  processingTotal: number;
};
```

### 4.2 Checkbox (`features/documents/DocumentRow.tsx`)

| Trạng thái tài liệu | Checkbox |
|---|---|
| `READY` (kể cả có trang không đọc được) | Bật |
| `QUEUED`, `PROCESSING` | Bật (đề xuất) — người dùng có thể chọn file vừa tải để hỏi ngay khi sẵn sàng |
| `FAILED` | Vô hiệu, `title="Tài liệu lỗi không dùng được để hỏi"` |
| Đang tải lên (chưa có `document_id`) | Không có checkbox |

- `aria-label="Chỉ hỏi trong {tên file}"`; hàng được chọn có class `is-selected` (nền `--color-primary-soft`).
- Tối đa 200 lựa chọn: lần tick thứ 201 bị chặn, toast "Chỉ chọn được tối đa 200 tài liệu" (đề xuất, khớp giới hạn API).
- Lọc theo tên (T01-09) không làm mất lựa chọn của hàng bị ẩn; chân sidebar ghi "Đã chọn N" khi có lựa chọn.

### 4.3 ScopeBar (`features/chat/ScopeBar.tsx`)

| `kind` | Nội dung (aria-live polite) |
|---|---|
| `none-ready` | "Chưa có tài liệu sẵn sàng để hỏi." |
| `all` | "Đang hỏi trong: Tất cả {readyTotal} tài liệu sẵn sàng" (AC-US013-3) |
| `selected` | "Đang hỏi trong {n} tài liệu" + nút liên kết "Hỏi trong tất cả" (`onClearScope`) (AC-US013-1) |
| `selected-not-ready` | "Các tài liệu đã chọn chưa sẵn sàng" + "Hỏi trong tất cả" |
| ghi chú phụ | `selected`: "· {selectedProcessing} tài liệu đã chọn đang xử lý chưa được dùng"; `all`: "· {processingTotal} tài liệu đang xử lý chưa được dùng" |

### 4.4 Composer và gửi câu hỏi

- `kind = "selected-not-ready"` → `QuestionComposer disabled`, `disabledReason = "Các tài liệu đã chọn chưa sẵn sàng"` (AC-US013-4, EC-18). Polling 5 s của T01-09 tự mở lại khi một tài liệu chuyển `READY`.
- Khi gửi: `scope_document_ids = kind === "selected" ? selectedReadyIds : undefined` (bỏ chọn hết → không gửi trường, AC-US013-3).
- API trả 409 `NO_READY_DOCUMENTS` (đua với polling) → giữ câu hỏi trong ô soạn, hiển thị `disabledReason` tương ứng, refetch documents.
- Trạng thái "Đang tìm trong {meta.docs_in_scope} tài liệu{scope_type === 'selected' ? ' đã chọn' : ''}…" và khối not_found "Đã tìm trong {n} tài liệu đã chọn. … kiểm tra phạm vi tài liệu…" dùng `meta` (sửa `AnswerMessage` của T02-07/T03-03).

### 4.5 Dọn lựa chọn

`useEffect` trên dữ liệu `documents` → `prune(ids hiện có)`: tài liệu bị gỡ/không còn trong danh sách bị loại khỏi lựa chọn. Lựa chọn rỗng sau prune → về `all` và toast thông tin "Một tài liệu trong phạm vi đã bị gỡ" (đề xuất).

## 5. Các bước thực hiện

- [ ] `scopeStore` + `deriveScope` + unit test.
- [ ] Checkbox trong `DocumentRow`, giới hạn 200, hiển thị "Đã chọn N".
- [ ] `ScopeBar` + nút "Hỏi trong tất cả".
- [ ] Nối composer (disabled) và client gửi `scope_document_ids` (sửa `lib/api/messages.ts` của T02-06).
- [ ] Cập nhật thông điệp đang tìm / not_found theo `meta.scope_type`.
- [ ] EV-14; MSW handler 409; Playwright + axe.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US013-1:** tick 3 tài liệu, gửi câu hỏi → thanh phạm vi "Đang hỏi trong 3 tài liệu" và mọi chip trích dẫn thuộc 3 tài liệu (E2E trên staging với Claude thật, kiểm tra `document_id` của mọi citation).
- [ ] **AC-US013-3:** bỏ chọn hết → request không có `scope_document_ids`, thanh phạm vi "Tất cả N tài liệu sẵn sàng".
- [ ] **AC-US013-4:** chỉ chọn tài liệu đang xử lý → ô hỏi vô hiệu với "Các tài liệu đã chọn chưa sẵn sàng"; khi tài liệu sẵn sàng, ô hỏi tự bật lại trong ≤ 10 s.
- [ ] Checkbox thao tác được bằng bàn phím (Space), có nhãn; axe không có lỗi serious/critical.
- [ ] EV-14 phát đúng `docs_selected`.

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | `deriveScope`: kho trống; chỉ processing; chọn 3 READY; chọn 2 READY + 1 PROCESSING; chọn 1 PROCESSING; prune tài liệu bị gỡ |
| Component | Checkbox FAILED vô hiệu; lần chọn thứ 201 bị chặn; "Hỏi trong tất cả" xoá lựa chọn |
| E2E (`FakeLLMAdapter`) | Chọn 3 → hỏi → request body đúng; chọn tài liệu vừa tải (đang xử lý) → composer vô hiệu → sau READY → bật; 409 giả lập → câu hỏi không mất |
| E2E (staging) | AC-US013-1 với bộ PDF mẫu 2 dự án; AC-US013-2 cùng kịch bản với golden set (T04-03) |

## 8. Analytics / observability

- EV-14 `scope_changed` `{docs_selected}` (P1), debounce 1 s để không phát mỗi lần tick liên tiếp (đề xuất); "Hỏi trong tất cả" phát `docs_selected: 0`.
- EV-08 `scope_type`, `docs_in_scope` do server ghi (T04-03).

## 9. Tham chiếu

PRD UX-05, EC-03, EC-18; Blueprint §3.6.2, §3.7.4, UXD-05; prototype `workspace.js` (`scopeIds`, `renderScope`), `components.css` `.scope-bar`; SAD §4.1, §10.2–10.3; USER_STORIES US-013.

## 10. Giả định và câu hỏi mở

- Giả định: `DocumentVM` có `status`; `GET /documents` trả toàn bộ tài liệu chưa gỡ (≤ 500 ở pilot) nên tính `readyTotal` phía client được; nếu phân trang thật, dùng `meta.docs_in_scope` hoặc thêm `counts` vào API (đề xuất).
- **OQ-T0404-01:** Cho phép tick tài liệu đang xử lý (khác prototype) để thoả AC-US013-4 — PO/UX xác nhận. Nếu giữ như prototype thì AC-US013-4 không bao giờ xảy ra và cần sửa AC.
- **OQ-T0404-02:** Có lưu lựa chọn phạm vi qua phiên (localStorage) hoặc theo hội thoại không? Đề xuất chỉ `sessionStorage` của tab.
