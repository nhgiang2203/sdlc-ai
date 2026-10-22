# T01-09 — FE: danh sách tài liệu, trạng thái, polling, empty state

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-003 · WP-12 |
| Loại | FE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T01-03](T01-03-fe-auth-api-client.md) (thực tế cũng cần hợp đồng [T01-07](T01-07-document-list-api.md)) |
| Chặn | [T02-09](T02-09-fe-document-errors.md), [T04-04](T04-04-fe-scope-selection.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hiển thị cột "Kho tài liệu" gồm: mỗi dòng có tên, người đưa vào, ngày, trạng thái (biểu tượng + chữ), mới nhất trước; ô lọc theo tên không phân biệt dấu; trạng thái tự cập nhật trong ≤ 10 s nhờ polling 5 s khi còn tài liệu đang xử lý; empty state khi kho trống; cảnh báo "X trang không đọc được văn bản" trong chi tiết tài liệu.

## 2. Bối cảnh

- SAD §4.1 (TanStack Query `documents`, polling 5 s khi còn `QUEUED`/`PROCESSING`, dừng khi ổn định), ADR-011; §9.1 (bảng hiển thị trạng thái).
- Blueprint §3.6.2 (`DocumentSidebar`, `DocumentRow`, `StatusBadge`, `EmptyState`), §3.2.2 (`DocumentVM`, mapper tính nhãn một lần), §3.5.2 (`documents`, `sidebarCollapsed`), UX-07 (biểu tượng + chữ), UX-11 (768–1279 px thu gọn thành nút).
- Prototype: `workspace.html` `#sidebar`, `workspace.js` (`badge`, `renderSidebar`, `renderEmpty`), `mock-data.js` (6 tài liệu mẫu, `errorText`).
- Section "Đang tải lên" và dropzone là T01-08. Checkbox chọn phạm vi là T04-04. Nút gỡ/xoá là T05-04 và T02-09.

## 3. Phạm vi

**Trong phạm vi:** `features/documents/sidebar/*` (`DocumentSidebar`, `DocumentRow`, `StatusBadge`, `DocumentFilter`, `DocumentDetailsPopover`, `SidebarFooter`); `features/documents/api.ts` (`useDocuments`, `useDocument`); mapper `toDocumentVM`; `WorkspaceEmptyState` (EC-01) đặt ở vùng hội thoại; thu gọn sidebar ở màn hình hẹp; skeleton khi đang tải.

**Ngoài phạm vi:** checkbox phạm vi + ScopeBar (T04-04); nút "Gỡ" (T05-04); "Xoá khỏi danh sách" và lý do lỗi chi tiết (T02-09; ở S1 dòng `FAILED` chỉ hiện badge "Lỗi" kèm lý do lấy từ `errorText`); empty state "đang xử lý" và "sẵn sàng" của vùng hội thoại (T02-06).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Nội dung |
|---|---|
| `frontend/src/features/documents/api.ts` | `useDocuments({q})`, `useDocument(id)`, hằng `POLL_MS = 5000` |
| `frontend/src/lib/api/types.ts` | `DocumentDto`, `DocumentListDto` (SAD §10.2) |
| `frontend/src/lib/api/mappers.ts` | `toDocumentVM(dto)` |
| `frontend/src/features/documents/sidebar/DocumentSidebar.tsx` | Khung cột: tiêu đề "Kho tài liệu", `UploadDropzone` (T01-08), `DocumentFilter`, danh sách, footer |
| `.../DocumentRow.tsx` | Một dòng tài liệu |
| `.../StatusBadge.tsx` | `status: "ready" \| "processing" \| "failed" \| "warning" \| "removed"` |
| `.../DocumentFilter.tsx` | Ô `type="search"` "Lọc theo tên tài liệu" + nhãn ẩn |
| `.../DocumentDetailsPopover.tsx` | Chi tiết (Radix Popover) |
| `.../SidebarFooter.tsx` | "{r} sẵn sàng · {p} đang xử lý · {f} lỗi" |
| `frontend/src/features/documents/WorkspaceEmptyState.tsx` | EC-01 |
| `frontend/src/app/routes/Workspace.tsx` | Đặt `WorkspaceEmptyState` vào vùng hội thoại khi kho trống (S2 thay bằng `ChatThread`) |

### 4.2 Dữ liệu và polling

```ts
useInfiniteQuery({
  queryKey: ["documents", { q }],
  queryFn: ({ pageParam, signal }) =>
    apiFetch<DocumentListDto>(`/api/v1/documents?page_size=100${q ? `&q=${enc(q)}` : ""}${pageParam ? `&cursor=${pageParam}` : ""}`,
             { signal, background: isPollingRef.current }),
  getNextPageParam: (last) => last.next_cursor ?? undefined,
  refetchInterval: (query) => hasPending(query.state.data) ? POLL_MS : false,
  refetchIntervalInBackground: false,      // tab ẩn thì dừng poll, mở lại thì refetch ngay
  staleTime: 0,
});
```

- Tự gọi `fetchNextPage()` cho tới khi hết `next_cursor` để có đủ N dòng (đề xuất; pilot ≤ vài trăm tài liệu).
- `hasPending` = có tài liệu `QUEUED` hoặc `PROCESSING`. Có mục trong `useUploadQueue` thì cũng poll.
- Request do polling gắn `background: true`, tức `X-CWD-Background: 1`, để không gia hạn phiên. Lần tải đầu và lần lọc do người dùng gõ thì **không** gắn.
- Lọc: debounce 300 ms, gọi server với `q` (bỏ dấu ở server, T01-07). Trong lúc chờ, lọc tạm trên dữ liệu đang có bằng `fold()` (lấy từ prototype `common.js`, chuyển vào `lib/i18n/fold.ts`) để phản hồi tức thì.
- Lỗi mạng khi poll: giữ dữ liệu cũ, không toast. Banner offline do AppShell lo (T00-10).

### 4.3 `toDocumentVM` và hiển thị

| DTO | VM / hiển thị |
|---|---|
| `status` `QUEUED`/`PROCESSING` | `StatusBadge processing`: icon `loader` (xoay, tắt khi `prefers-reduced-motion`) + "Đang xử lý" |
| `READY`, `unreadable_pages = 0` | `ready`: icon `check` + "Sẵn sàng" |
| `READY`, `unreadable_pages > 0` | `warning`: icon `alert` + "Sẵn sàng · {n} trang không đọc được" |
| `FAILED` | `failed`: icon `alertCircle` + "Lỗi"; dòng `doc-error` hiện `ERROR_TEXT[error_reason] ?? ERROR_TEXT.other` (chuỗi lấy từ `mock-data.js` `errorText`, chuyển vào `lib/i18n/vi.ts`) |
| `uploaded_by.display_name`, `uploaded_at` | `uploadedByName`, `uploadedAtLabel` = `dd/MM/yyyy` theo giờ Asia/Ho_Chi_Minh (`Intl.DateTimeFormat("vi-VN")`) |
| `page_count` | "{n} trang" (ẩn nếu `null` hoặc `FAILED`) |

Dòng (`<li class="doc-row">`): icon file, tên (`doc-name`, có `title` đầy đủ, cắt bằng ellipsis), `doc-meta` = badge · số trang · "{người} · {ngày}". Tên file luôn render dạng text (React tự escape).

**Chi tiết (AC-US003-5):** bấm tên tài liệu (ở S1; từ T04-04 checkbox nhận click vào nhãn, nên chi tiết chuyển sang nút `info` riêng) → `DocumentDetailsPopover` gọi `useDocument(id)` và hiển thị: tên, dung lượng (`fmtBytes`), số trang, người đưa vào, ngày giờ, trạng thái. Khi `unreadable_pages > 0` có callout warning "**{n} trang không đọc được văn bản.** Nội dung các trang này không được dùng để trả lời."

**Danh sách rỗng do lọc:** "Không có tài liệu khớp “{q}”." + nút liên kết "Xoá bộ lọc".

### 4.4 Empty state (AC-US003-4, EC-01)

Kho trống (không có tài liệu, không có mục tải lên) thì vùng hội thoại hiển thị `EmptyState`: icon `upload`, tiêu đề "Bắt đầu bằng cách thêm tài liệu", thân "Chưa có tài liệu nào. Kéo-thả file PDF vào đây để bắt đầu", nút primary "Chọn file" → `useFilePicker().openPicker()` (T01-08). Sidebar hiển thị "Chưa có tài liệu nào." Vùng empty state nhận thả file bằng chính handler của `UploadDropzone`.

### 4.5 Bố cục hẹp (UX-11)

768–1279 px: sidebar thu gọn thành nút "Kho tài liệu" (`icon layout`) ở đầu vùng hội thoại và mở dạng drawer (`aria-expanded`, Esc để đóng). Trạng thái thu gọn lưu `localStorage` khoá `cwd.ui.sidebar` (try/catch).

## 5. Các bước thực hiện

- [ ] Thêm `DocumentDto` và `toDocumentVM` + unit test.
- [ ] Viết `useDocuments` (infinite + tự tải hết trang + polling + background header) và `useDocument`.
- [ ] Chuyển `fold`, `fmtBytes`, `errorText` từ prototype vào `lib/i18n`.
- [ ] Viết `StatusBadge`, `DocumentRow`, `DocumentFilter`, `SidebarFooter`, `DocumentSidebar`, skeleton 5 dòng khi tải lần đầu.
- [ ] Viết `DocumentDetailsPopover`.
- [ ] Viết `WorkspaceEmptyState` và gắn vào `Workspace.tsx`.
- [ ] Viết drawer cho màn hình hẹp.
- [ ] Viết component test, E2E và kiểm tra axe.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US003-3:** tài liệu đổi `PROCESSING → READY` trên server → giao diện đổi badge trong ≤ 10 s mà không tải lại trang (Playwright đo thời gian từ lúc đổi trạng thái trong DB tới khi thấy "Sẵn sàng"). Khi mọi tài liệu ổn định thì không còn request polling (kiểm tra network trong 15 s).
- [ ] **AC-US003-4:** kho trống → thấy đúng chuỗi "Chưa có tài liệu nào. Kéo-thả file PDF vào đây để bắt đầu" và nút "Chọn file". Bấm nút mở hộp chọn file.
- [ ] **AC-US003-5:** tài liệu `READY` có `unreadable_pages = 2` → badge "Sẵn sàng · 2 trang không đọc được", mở chi tiết thấy "2 trang không đọc được văn bản".
- [ ] Hiển thị đúng N dòng theo AC-US003-1 (API ở T01-07): kiểm với 0, 6 (fixture prototype) và 120 tài liệu; thứ tự mới nhất trước; mỗi dòng có tên, người, ngày, trạng thái.
- [ ] Lọc "hop dong" trên giao diện khớp tài liệu "Hợp đồng…" (đầu-cuối, cùng AC-US003-2 ở T01-07).
- [ ] **E2E J1 phần S1:** đăng nhập → tải PDF → "Đang xử lý" → "Sẵn sàng" chạy trên staging (exit criteria S1).
- [ ] Trạng thái không chỉ dựa vào màu (UX-07); axe-core không có lỗi nghiêm trọng; Tab đi được qua ô lọc và từng dòng.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `toDocumentVM` cho 5 nhánh trạng thái; `uploadedAtLabel` đổi đúng múi giờ (UTC 18:30 → ngày hôm sau ở VN) |
| Unit | `hasPending` và `refetchInterval`: có `QUEUED` → 5000; tất cả `READY/FAILED` → `false`; có upload đang chạy → 5000 |
| Component | `DocumentSidebar` với MSW: skeleton → danh sách; lọc rỗng → "Không có tài liệu khớp"; "Xoá bộ lọc" khôi phục danh sách |
| Component | Polling: fake timers, MSW trả `PROCESSING` 2 lần rồi `READY` → badge đổi; header `X-CWD-Background` có trong request poll và không có trong request đầu |
| E2E | Kho trống (DB sạch) → empty state; tải lên → "Sẵn sàng"; tài liệu `mixed_scan_12p.pdf` → cảnh báo 2 trang |
| A11y | axe-core ở các trạng thái danh sách, rỗng, lọc rỗng, popover chi tiết |

## 8. Analytics / observability

- Không có sự kiện EV riêng (US-003 dùng EV-01 cho phễu).
- Đếm số request polling trong test hiệu năng S2 để ước lượng tải lên API (N người × 0,2 req/s khi có tài liệu đang xử lý).

## 9. Tham chiếu

SAD §4.1, §9.1, §10.2, ADR-011; Blueprint §3.2.2, §3.5.2, §3.6.2, §3.6.4; PRD UX-07, UX-11, EC-01, EC-10; prototype `workspace.html`, `assets/workspace.js` (`badge`, `renderSidebar`, `renderEmpty`), `assets/mock-data.js`; USER_STORIES US-003.

## 10. Giả định và câu hỏi mở

- Giả định: pilot ≤ ~500 tài liệu, nên tải hết các trang (100/trang) mỗi 5 s khi có tài liệu đang xử lý là chấp nhận được. Nếu kho lớn hơn thì cần endpoint/tham số "chỉ trả tài liệu đang xử lý" để poll nhẹ hơn.
- Ở S1, bấm tên mở chi tiết. Từ T04-04 tên là `<label>` của checkbox, nên chi tiết phải chuyển sang nút riêng. T04-04 cần biết điều này.
- **OQ-115:** "Ngày đưa vào" hiển thị chỉ ngày (`dd/MM/yyyy`, như prototype) hay cả giờ? Đề xuất: danh sách chỉ hiện ngày, chi tiết hiện cả giờ.
