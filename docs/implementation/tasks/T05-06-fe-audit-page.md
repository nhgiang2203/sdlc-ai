# T05-06 — FE: trang nhật ký tài liệu

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | US-007 · WP-52 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T05-05](T05-05-audit-log-api.md); liên quan [T01-03](T01-03-fe-auth-api-client.md) (`/me`, guard, Forbidden), [T00-10](T00-10-design-system-appshell.md) (AppShell, `Badge`, `EmptyState`) |
| Chặn | — |
| Trạng thái | Todo |

## 1. Mục tiêu

Trang "Nhật ký tài liệu" cho trưởng nhóm: bảng các thao tác đưa vào / gỡ / lỗi xử lý, mới nhất trước, lọc theo khoảng ngày, tải thêm theo trang; người không có vai trò `lead` thấy "Bạn không có quyền xem trang này" và không thấy mục menu.

## 2. Bối cảnh

- SAD §4.1 route `/documents/audit` (vai trò lead).
- Blueprint §3.1.2 (`features/documents` chứa `AuditLogPage`), §3.4 UF-06 (Menu → "Nhật ký tài liệu" → lọc khoảng ngày → đọc; không phải lead → 403), §3.6.2 `AuditTable` (`entries`, `range`, sự kiện `onRangeChange`, `onLoadMore`; trạng thái `loading`, `empty`, `list`, `forbidden`), `StatusBadge`, `EmptyState`.
- Prototype `audit.html`: tiêu đề + mô tả "Nhật ký chỉ đọc, không chỉnh sửa được."; form "Từ ngày"/"Đến ngày" (`input type=date`) + "Áp dụng"; lỗi "“Từ ngày” phải trước hoặc bằng “Đến ngày”." và "Khoảng thời gian tối đa 90 ngày."; bảng `table.data` có `caption` ẩn; badge `Đã tải lên` (info, `upload`), `Đã gỡ` (neutral, `trash`), `Xử lý lỗi` (failed, `alertCircle`) kèm ghi chú lý do; empty "Không có thao tác nào trong khoảng thời gian này"; màn hình không quyền có biểu tượng khoá và nút "Về trang Hỏi đáp". `assets/common.js` ẩn mục menu khi không `canAudit`.

## 3. Phạm vi

**Trong phạm vi:** route + guard vai trò; mục điều hướng; `AuditLogPage`, `AuditRangeForm`, `AuditTable`; `useInfiniteQuery`; định dạng thời gian; trạng thái loading/empty/error/forbidden; test + axe.

**Ngoài phạm vi:** API ([T05-05](T05-05-audit-log-api.md)); xuất CSV, tìm theo tên tài liệu/người (chưa có yêu cầu).

## 4. Thiết kế chi tiết

### 4.1 File

| File | Nội dung |
|---|---|
| `frontend/src/app/routes.tsx` | Route `/documents/audit` → lazy `AuditLogPage`, bọc `RequireRole role="lead"` |
| `frontend/src/app/RequireRole.tsx` | Dùng `me.roles`; thiếu vai trò → render `ForbiddenPanel` (không chuyển URL) |
| `frontend/src/app/AppHeader.tsx` | Mục "Nhật ký tài liệu" (biểu tượng `log`) chỉ khi `roles.includes("lead")` |
| `frontend/src/features/documents/audit/AuditLogPage.tsx` | Tiêu đề, mô tả, form, bảng |
| `frontend/src/features/documents/audit/AuditRangeForm.tsx` | Hai ô ngày + "Áp dụng", validation |
| `frontend/src/features/documents/audit/AuditTable.tsx` | Bảng + "Tải thêm" |
| `frontend/src/features/documents/audit/useAuditLog.ts` | `useInfiniteQuery(["audit", from, to], …)`, `getNextPageParam = p => p.next_cursor` |
| `frontend/src/lib/i18n/format.ts` | `formatDateTime(iso)` → `dd/MM/yyyy HH:mm` theo `Asia/Ho_Chi_Minh` |

### 4.2 Bộ lọc

- Mặc định: 30 ngày gần nhất (hôm nay − 29 → hôm nay), khớp mặc định API (đề xuất).
- Giá trị lưu trong URL `?from=YYYY-MM-DD&to=YYYY-MM-DD` để chia sẻ/quay lại.
- Chuyển sang API: `from = {from}T00:00:00+07:00`, `to = ({to} + 1 ngày)T00:00:00+07:00` (đầu ngày kế tiếp, vì `to` của API không bao gồm).
- Validation phía client trước khi gọi (giữ thông điệp prototype): `from > to` → "“Từ ngày” phải trước hoặc bằng “Đến ngày”." (gắn `aria-invalid`, `aria-describedby`); > 90 ngày → "Khoảng thời gian tối đa 90 ngày."; vẫn hiển thị lỗi 400 từ server nếu có.

### 4.3 Bảng

| Cột | Nội dung |
|---|---|
| Thời điểm | `formatDateTime(at)`; `<time dateTime={at}>` |
| Thao tác | `StatusBadge` biểu tượng + chữ: `DOCUMENT_UPLOADED` "Đã tải lên", `DOCUMENT_REMOVED` "Đã gỡ", `DOCUMENT_FAILED` "Xử lý lỗi" + dòng phụ lý do theo `error_reason` (dùng bảng chuỗi lỗi của T02-09) |
| Tài liệu | `document.filename` (văn bản thuần, cắt bằng CSS + `title`) |
| Người thực hiện | `actor.display_name` hoặc "Hệ thống" khi `actor = null` |

- Thứ tự giữ nguyên thứ tự server (mới nhất trước); không cho sắp xếp lại.
- Không có hành động sửa/xoá trên hàng (AC-US007-4 về giao diện).
- "Tải thêm" khi có `next_cursor`; `aria-live` thông báo "Đã tải thêm N bản ghi".
- Trạng thái: `loading` — skeleton 5 hàng; `empty` — `EmptyState` "Không có thao tác nào trong khoảng thời gian này" / "Thử chọn khoảng thời gian khác."; `error` — banner lỗi + "Thử lại" (`refetch`); `forbidden` — `ForbiddenPanel` "Bạn không có quyền xem trang này" + "Nhật ký tài liệu chỉ dành cho trưởng nhóm Phát triển kinh doanh." + nút "Về trang Hỏi đáp". API trả 403 (vai trò bị thu hồi giữa phiên) → cũng hiển thị `forbidden`.
- Bề rộng 768–1279px: bảng cuộn ngang trong `.table-wrap`.

## 5. Các bước thực hiện

- [ ] `RequireRole` + `ForbiddenPanel` (dùng lại trang Forbidden của T01-03 nếu có).
- [ ] Mục menu theo vai trò.
- [ ] `AuditRangeForm` + validation + đồng bộ URL.
- [ ] `useAuditLog` + `AuditTable` + "Tải thêm".
- [ ] MSW handler từ `mock-data.js` `audit` (thêm `error_reason`, `actor: null`).
- [ ] Vitest, Playwright với 3 vai trò, axe.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US007-1:** sau khi có thao tác tải lên, gỡ, lỗi xử lý, trưởng nhóm mở "Nhật ký tài liệu" thấy mỗi bản ghi có người thực hiện, loại thao tác, tên tài liệu, thời điểm, mới nhất ở trên (E2E staging với dữ liệu thật tạo bởi kịch bản).
- [ ] **AC-US007-2:** chọn khoảng ngày rồi "Áp dụng" → chỉ hiển thị bản ghi trong khoảng (kiểm tra biên: bản ghi lúc 23:59 ngày "Đến ngày" có mặt, bản ghi 00:00 ngày kế tiếp không có).
- [ ] Hỗ trợ AC-US007-3: người dùng `user`/`manager` không thấy mục menu; truy cập trực tiếp URL thấy "Bạn không có quyền xem trang này".
- [ ] Bảng có `caption`, `th scope="col"`; badge không chỉ dựa vào màu; axe không có lỗi serious/critical; thao tác được hoàn toàn bằng bàn phím.
- [ ] Route được tách bundle (không tăng bundle khởi tạo).

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | Chuyển khoảng ngày → tham số API (+07:00, `to` + 1 ngày, qua ranh giới tháng/năm); `formatDateTime`; validation |
| Component (MSW) | loading → list; empty; 2 trang với "Tải thêm"; 403 → forbidden; 500 → error + Thử lại; actor null → "Hệ thống" |
| E2E (Playwright) | Đăng nhập Keycloak với `cwd-leads` → thấy menu, lọc; `cwd-users` → không menu, URL trực tiếp → thông báo không quyền; `cwd-managers` → như `cwd-users` |
| Accessibility | axe trên các trạng thái list, empty, forbidden |

## 8. Analytics / observability

- Không có sự kiện trong danh mục EV cho trang này; không thêm sự kiện mới (thay đổi danh mục cần PO duyệt).

## 9. Tham chiếu

USER_STORIES US-007; Blueprint §3.1.2, §3.4 UF-06, §3.6.2 (`AuditTable`, `StatusBadge`, `EmptyState`); prototype `audit.html`, `assets/common.js` (`canAudit`, menu), `assets/components.css` (`table.data`, `.table-wrap`), `assets/mock-data.js` (`audit`); SAD §4.1, §10.2.

## 10. Giả định và câu hỏi mở

- Giả định: múi giờ hiển thị cố định `Asia/Ho_Chi_Minh` cho mọi người dùng (đề xuất; ứng dụng nội bộ một site).
- **OQ-T0506-01:** Mặc định 30 ngày (đề xuất) hay khoảng như prototype (từ đầu tháng trước)?
- **OQ-T0506-02:** Có cần lọc theo loại thao tác hoặc tên tài liệu không? Không có trong AC; để sau MVP.
