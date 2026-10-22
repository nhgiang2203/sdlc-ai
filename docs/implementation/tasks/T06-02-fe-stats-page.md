# T06-02 — FE: trang Thống kê

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-019, US-020 · WP-60 |
| Loại | FE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T06-01](T06-01-weekly-stats-api.md) (hợp đồng `GET /stats/weekly`; làm song song bằng MSW), [T01-03](T01-03-fe-auth-api-client.md) (API client, guard, Forbidden), [T00-10](T00-10-design-system-appshell.md) (design system, AppShell) |
| Chặn | [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Xây trang `/stats` cho vai trò `manager`: 4 ô số liệu tuần gần nhất, 2 biểu đồ cột (người dùng hoạt động, số câu hỏi), bảng số liệu theo tuần, bộ chọn khoảng 4/8 tuần; ẩn mục "Thống kê" khỏi menu với người không có vai trò và hiển thị "Bạn không có quyền xem trang này" khi truy cập trực tiếp; phát EV-19.

## 2. Bối cảnh

- Persona PER-03 (Quản lý) dùng trang này hằng tuần trong pilot và cho báo cáo sponsor (J4, UF-07 — hiển thị ≤ 2 s).
- Prototype: [stats.html](../../design/UI_UX_design/stats.html) (tile + delta so với tuần trước, biểu đồ cột SVG có tooltip và nhãn giá trị cột cuối, bảng `table.data`, segmented control, empty state, màn không có quyền); menu ở [common.js](../../design/UI_UX_design/assets/common.js) (`show: s.canStats`); dữ liệu mẫu `weekly` trong [mock-data.js](../../design/UI_UX_design/assets/mock-data.js).
- Blueprint §3.1.2 `features/stats`, §3.6.2 component `WeeklyStats` (states loading, empty, data, forbidden), token `--chart-series-1` (đã qua validator dataviz).

## 3. Phạm vi

**Trong phạm vi:** route `/stats` + guard vai trò; `StatsPage`, `WeeklyStats` (tiles, charts, table), `RangeSelector`; hook TanStack Query `useWeeklyStats`; ẩn/hiện mục menu theo `me.roles`; EV-19; test Vitest + Playwright + axe.

**Ngoài phạm vi:** API, MV, đối chiếu số liệu → [T06-01](T06-01-weekly-stats-api.md). Xuất CSV, chọn khoảng tuỳ ý, so sánh theo người dùng (không có trong PRD). Dashboard vận hành → [T06-04](T06-04-metrics-dashboards-alerts.md).

## 4. Thiết kế chi tiết

### 4.1 File / module

| File | Nội dung |
|---|---|
| `frontend/src/app/routes.tsx` | Thêm `{ path: "/stats", element: <RequireRole role="manager"><StatsPage/></RequireRole> }` (lazy import) |
| `frontend/src/app/nav.ts` | Mục điều hướng `{ id: "stats", to: "/stats", icon: "chart", label: "Thống kê", visible: (me) => me.roles.includes("manager") }` |
| `frontend/src/features/stats/api.ts` | `fetchWeeklyStats({from, to})` dùng `lib/api` client; kiểu `WeeklyStatsDTO` |
| `frontend/src/features/stats/useWeeklyStats.ts` | `useQuery(["stats","weekly",range], …, { staleTime: 5 * 60_000 })` |
| `frontend/src/features/stats/isoWeek.ts` | Tính `from`/`to` cho N tuần gần nhất theo giờ VN; nhãn `T08`, "Tuần 08 · 2027" |
| `frontend/src/features/stats/StatsPage.tsx` | Header trang, mô tả "Số liệu theo tuần (thứ Hai – Chủ nhật). Không chứa nội dung câu hỏi của người dùng.", `RangeSelector`, `WeeklyStats` |
| `frontend/src/features/stats/WeeklyStats.tsx` | Chọn state: loading (skeleton), empty, data, error |
| `frontend/src/features/stats/StatTiles.tsx` | 4 tile: "Người dùng hoạt động" (`active / authorized`), "Số câu hỏi", "Tỷ lệ “không tìm thấy”", "Tỷ lệ câu trả lời hữu ích"; delta so với tuần trước |
| `frontend/src/features/stats/ColumnChart.tsx` | Biểu đồ cột SVG một chuỗi, port từ `columnChart()` của prototype |
| `frontend/src/features/stats/StatsTable.tsx` | Bảng: Tuần · Người dùng hoạt động · Tỷ lệ hoạt động · Số câu hỏi · Không tìm thấy · Hữu ích |
| `frontend/src/features/stats/format.ts` | `pct(v)` (null → "—"), `num(v)` `toLocaleString("vi-VN")`, delta "điểm %" |
| `frontend/src/lib/api/mocks/stats.ts` | Handler MSW từ `mock-data.js#weekly` (8 tuần) + biến thể rỗng, 403 |

### 4.2 Hành vi

| Tình huống | Hiển thị |
|---|---|
| `me` chưa có `manager` | Mục "Thống kê" không render trong nav (không chỉ ẩn bằng CSS) |
| Truy cập `/stats` không có vai trò, hoặc API trả 403 | `EmptyState` icon `lock`, tiêu đề "Bạn không có quyền xem trang này", thân "Thống kê sử dụng chỉ dành cho vai trò Quản lý.", nút "Về trang Hỏi đáp" (`/`). Không gọi API khi guard đã biết thiếu vai trò |
| Đang tải | Skeleton cho 4 tile + 2 khung biểu đồ; đổi khoảng giữ dữ liệu cũ mờ 55% (`placeholderData: keepPreviousData`) |
| Mọi tuần đều `questions = 0` | Empty state icon `chart`: "Chưa có dữ liệu sử dụng" / "Số liệu sẽ xuất hiện sau tuần đầu tiên của pilot." |
| Lỗi mạng/5xx | `Banner` danger "Không tải được số liệu." + nút "Thử lại" (`refetch`) |
| Tỷ lệ `null` (mẫu số 0) | Hiển thị "—", tooltip "Chưa có câu trả lời/đánh giá trong tuần" |
| Có header `X-Stats-Refreshed-At` | Dòng phụ "Cập nhật lúc HH:mm" (đề xuất) |

- Delta: số lượng hiển thị `+n`/`−n so với tuần trước`; tỷ lệ hiển thị theo **điểm %**; màu `up`/`down` theo chiều "tốt" (tỷ lệ không tìm thấy giảm là tốt) + mũi tên — không chỉ dựa màu (UXD-07).
- Biểu đồ 1: trục Y cố định tới `authorized_users` lớn nhất (prototype dùng 20); biểu đồ 2: `niceMax`. Mỗi cột có vùng hit `tabindex=0` + `aria-label="2027-W08: 188 câu hỏi"`, tooltip khi hover/focus; SVG `role="img"` với `aria-label` dẫn tới bảng. Màu cột `--chart-series-1`.
- Bộ chọn khoảng: `segmented` 2 nút `aria-pressed`, mặc định 8 tuần; lưu lựa chọn trong URL `?range=4` (đề xuất) để chia sẻ link.

### 4.3 Analytics

EV-19 `stats_viewed` phát **một lần mỗi lần mở trang** sau khi dữ liệu tải thành công lần đầu, `props: { period: "4w" | "8w" }` (đề xuất giá trị `period`); đổi khoảng không phát lại (đề xuất). Dùng `lib/analytics.track` (T01-10). Không phát khi 403.

## 5. Các bước thực hiện

- [ ] Viết handler MSW và kiểu DTO theo hợp đồng T06-01.
- [ ] `isoWeek.ts` + test (tuần 53/2026, đầu năm 2027).
- [ ] `StatTiles`, `StatsTable`, `format.ts`.
- [ ] Port `ColumnChart` từ prototype sang React (không dùng thư viện biểu đồ để giữ bundle nhỏ), resize bằng `ResizeObserver`.
- [ ] `StatsPage` + route lazy + `RequireRole`; nav ẩn mục theo vai trò.
- [ ] EV-19.
- [ ] Playwright: 3 vai trò (`user`, `lead`, `manager`) + axe.
- [ ] Kiểm tra với API thật trên staging sau khi T06-01 merge; so tile tuần gần nhất với kết quả script đối chiếu.

## 6. Tiêu chí hoàn thành

- [ ] **AC-US019-1:** với vai trò `manager`, trang hiển thị theo từng tuần: số người dùng hoạt động, tổng người được cấp quyền và tỷ lệ hoạt động, tỷ lệ "Không tìm thấy", tỷ lệ "hữu ích" (tile + bảng); E2E với dữ liệu MSW và staging.
- [ ] **AC-US020-1:** số câu hỏi của từng tuần trong khoảng đã chọn hiển thị ở biểu đồ 2 và cột "Số câu hỏi"; đổi 4 ↔ 8 tuần cập nhật đúng số hàng.
- [ ] **AC-US019-3:** người dùng không có vai trò `manager` không thấy mục "Thống kê" trong menu; mở `/stats` trực tiếp thấy "Bạn không có quyền xem trang này"; API trả 403 cũng dẫn tới cùng màn (E2E).
- [ ] AC-US018-3 (kiểm tra lại): trang không hiển thị nội dung câu hỏi hay tên người dùng nào.
- [ ] EV-19 ghi nhận trên staging với `period` (phục vụ LG-08).
- [ ] axe-core 0 lỗi serious/critical; điều hướng bàn phím qua segmented control và từng cột biểu đồ; tương phản đạt WCAG AA cả sáng/tối.
- [ ] Không vỡ bố cục ở 768 px (tile xếp 2 cột, bảng cuộn ngang trong `table-wrap`).

## 7. Kiểm thử

| Tầng | Ca |
|---|---|
| Vitest | `format.pct(null)` → "—"; delta điểm %; `isoWeek` ranh giới năm; `WeeklyStats` chọn đúng state |
| Testing Library | Nav không render "Thống kê" khi `roles=["user"]`; 403 → Forbidden; empty state khi mọi tuần 0 |
| Playwright | `manager` đổi khoảng; `user` truy cập `/stats`; tooltip qua bàn phím; axe trên trang có dữ liệu và trang Forbidden |
| Thủ công | Chrome + Edge, 1280 và 768 px, chế độ tối |

## 8. Analytics / observability

- EV-19 `stats_viewed` (`period`).
- Lỗi tải trang ghi qua error boundary + `request_id` từ problem+json (T00-08).

## 9. Tham chiếu

- USER_STORIES US-019, US-020, US-018 (AC-3); PRD §6.1 LG-08, §6.2 EV-19.
- Blueprint §3.1.2, §3.4 UF-07, §3.6.2 `WeeklyStats`, §3.6.3 token, UXD-07.
- Prototype `stats.html`, `assets/common.js`, `assets/components.css` (`.tiles`, `.tile-delta`, `.chart-card`, `.chart-tooltip`, `table.data`, `.segmented`).
- SAD §4.1 (route `/stats`, query `stats`), §10.2.

## 10. Giả định và câu hỏi mở

- Giả định: `GET /me` trả `roles` gồm `manager` (T01-02); vai trò quản lý có cả quyền `user` (xem OQ-170 ở [T07-03](T07-03-security-testing.md)).
- Giả định: chỉ 2 lựa chọn khoảng 4/8 tuần như prototype là đủ cho MVP; pilot 4 tuần nên 8 tuần bao gồm cả giai đoạn UAT.
- **OQ-163 (mới):** Giá trị `period` của EV-19 là nhãn khoảng ("4w"/"8w") hay `from–to` tuần ISO? PRD chỉ ghi `period`. Owner: PO.
