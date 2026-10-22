# T00-10 — Design system từ prototype + AppShell 3 vùng + MSW

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S0 (26/10 – 06/11/2026) |
| Story / WP | WP-08 |
| Loại | FE |
| Ước lượng | 4 ngày công |
| Phụ thuộc | [T00-02](T00-02-frontend-scaffold.md) |
| Chặn | [T01-03](T01-03-fe-auth-api-client.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Chuyển prototype `docs/design/UI_UX_design/` thành nền React dùng được ngay từ S1: (1) `design-system/` gồm token và primitive (Blueprint §3.1.2, §3.6.3); (2) `AppShell` (header, điều hướng theo vai trò, banner mất kết nối, skip link) và bố cục **workspace 3 vùng** (kho tài liệu 300px · hội thoại · vùng xem 520px) có responsive 768–1279px; (3) router với các route SAD §4.1; (4) MSW mock theo hợp đồng SAD §10 với fixture từ `mock-data.js` để Frontend làm song song khi API chưa xong.

## 2. Bối cảnh

- IMPLEMENTATION_PLAN §3: `tokens.css`, `components.css` chuyển thành `frontend/src/design-system/`; `mock-data.js` làm fixture MSW. WP-08 kết quả: "Storybook/route hiển thị layout với dữ liệu mock".
- Blueprint §3.6.2: interface component (`AppShell`, `Banner`, `Toast`, `EmptyState`, `ConfirmDialog`…); §3.6.3: bảng token light/dark; §2.5: tương phản WCAG AA, chữ 16/14 px, touch target ≥ 32 px (≥ 44 px dưới 768px), chuyển động ≤ 300 ms và tắt khi `prefers-reduced-motion`, toast tự ẩn 5 s.
- SAD §4.1: route `/`, `/c/:conversationId`, `/documents/audit` (lead), `/stats` (manager), `/forbidden`; Radix UI primitives cho bàn phím/ARIA; axe-core trong CI.
- Prototype: `workspace.html` (cấu trúc 3 vùng, class `.workspace`, `.sidebar`, `.chat`, `.viewer`), `assets/common.js` (bộ icon SVG kiểu Lucide, header, vai trò demo, toast, banner offline), `design-system.html` (trang trưng bày).

## 3. Phạm vi

**Trong phạm vi:**
- `src/design-system/`: `tokens.css`, `components.css`, `base.css`, primitive React §4.2, bộ icon.
- `src/app/`: `App.tsx`, `router.tsx`, `providers.tsx` (QueryClient, Toast provider, Tooltip provider), `AppShell.tsx`, `WorkspaceLayout.tsx`, `RoleGuard.tsx` (dựa trên `me.roles` từ mock), `ErrorBoundary.tsx`, trang `NotFound`, `Forbidden`.
- Placeholder cho từng vùng (`features/documents` → `DocumentSidebarPlaceholder`, `features/chat` → `ChatPlaceholder` có empty state 3 bước, `features/viewer` → `ViewerPlaceholder`) đủ để thấy layout.
- `src/mocks/`: MSW handlers + fixture theo SAD §10.2, §10.3.
- Route dev `/_design` tái hiện `design-system.html` (thay Storybook — đề xuất).
- Test Vitest + axe cho AppShell và primitive.

**Ngoài phạm vi:**
- `lib/api` client, guard đăng nhập thật, trang Forbidden có dữ liệu thật, giữ bản nháp → [T01-03](T01-03-fe-auth-api-client.md) (task này chỉ dựng `RoleGuard` đọc `me` qua một hook tạm `useMe()` gọi `fetch('/api/v1/me')`).
- Component nghiệp vụ: `DocumentSidebar`, `UploadDropzone`, `DocumentRow`, `StatusBadge` → T01-08/T01-09; `QuestionComposer`, `ChatThread`, `AnswerMessage`, `CitationChip` → T02-06/T02-07; `SourceViewer` → T04-02; `HistoryList` → T06-06; `AuditTable` → T05-06; `WeeklyStats` → T06-02.
- `lib/analytics` → [T01-10](T01-10-analytics-events.md); `lib/i18n` đầy đủ → task FE đầu tiên cần tiếng Anh (US-015 chỉ yêu cầu câu trả lời tiếng Anh; UI giữ tiếng Việt).
- E2E Playwright → task E2E S1.

## 4. Thiết kế chi tiết

### 4.1 CSS

| File | Nguồn | Xử lý |
|---|---|---|
| `design-system/tokens.css` | `assets/tokens.css` | Sao chép **nguyên giá trị** (light, dark theo `prefers-color-scheme` + `[data-theme]`, `prefers-reduced-motion`). Mọi màu/khoảng cách chỉ đi qua biến; thêm comment truy vết Blueprint §3.6.3 |
| `design-system/base.css` | Phần đầu `components.css` (dòng 1–33: reset, `body`, heading, `:focus-visible`, `.visually-hidden`, `.skip-link`) | Tách riêng |
| `design-system/components.css` | `assets/components.css` | Giữ class như prototype (`.btn`, `.btn-primary`, `.badge-ready`, `.callout-info`, `.toast`, `.dialog`, `.workspace`, `.sidebar`, `.chat`, `.viewer`, …) và các media query 1279/900/767px. Bỏ class chỉ dùng cho demo (`.demo-toggle`, `.demo-panel`, `.hub-*`, `.ds-*` chuyển sang `app/design-page.css`; `.pdf-page` mô phỏng trang PDF để lại cho T04-02). Prototype còn vài màu hard-code (`.btn-danger` chữ `#FFFFFF`/`#1A0707`, icon toast `#86EFAC`/`#FCA5A5`/`#166534`): chuyển thành token mới `--color-on-danger`, `--color-toast-success-icon`, `--color-toast-danger-icon` có giá trị light/dark (đề xuất, bổ sung vào Blueprint §3.6.3) |

Nhập một lần trong `app/main.tsx` theo thứ tự `tokens → base → components`. Không dùng CSS-in-JS (tương thích CSP `style-src` mặc định `'self'`). Không có `<style>` hay `style=""` sinh lúc chạy từ code của ta (xem §10 về Radix).

### 4.2 Primitive (`design-system/`)

| Component | Radix | Props chính | Class prototype |
|---|---|---|---|
| `Icon` | — | `name: IconName`, `size?: "sm"\|"md"\|"lg"`, `label?` (có `label` → `role="img"`, không → `aria-hidden`) | `.icon`; path SVG chép từ `common.js` `P` (logo, file, upload, check, checkCircle, alert, alertCircle, info, loader, clock, x, send, stop, copy, thumbUp, thumbDown, search, history, chart, log, chat, logout, plus, trash, chevronLeft/Right, arrowUp/Down, menu, refresh, wifiOff, lock, sparkle, sliders, layout) |
| `Button` | — | `variant: "primary"\|"secondary"\|"ghost"\|"danger"`, `size?: "sm"\|"md"`, `loading?`, `iconLeft?` | `.btn .btn-*` |
| `IconButton` | — | `label` (bắt buộc, làm `aria-label`), `icon`, `tooltip?` | `.icon-btn` (32px, 44px dưới 768px) |
| `Badge` | — | `tone: "ready"\|"processing"\|"failed"\|"info"\|"neutral"`, `icon`, `children` | `.badge-*` (luôn có icon + chữ — UX-07) |
| `Checkbox` | `@radix-ui/react-checkbox` | `checked`, `onCheckedChange`, `label` | `.checkbox` |
| `Dialog` | `@radix-ui/react-dialog` | `open`, `onOpenChange`, `title`, `description`, `children`, `actions` | `.dialog-backdrop`, `.dialog` |
| `ConfirmDialog` | dựng trên `Dialog` | Blueprint §3.6.2: `title, body, confirmLabel, tone, onConfirm, onCancel`, trạng thái `submitting` | `.dialog-actions` |
| `Toast` / `useToast()` | `@radix-ui/react-toast` | `tone`, `message`, `action?`; `duration` 5.000 ms; vùng `aria-live="polite"`, không che ô hỏi | `.toast-region`, `.toast` |
| `Tooltip` | `@radix-ui/react-tooltip` | `content`, `children`; delay 400 ms (đề xuất) | — |
| `Banner` | — | `tone: "warning"\|"info"`, `icon`, `children`; `role="status"` | `.banner-*` |
| `Callout` | — | `tone: "info"\|"warning"\|"danger"`, `title`, `children` | `.callout-*` (dùng cho not_found, partial ở S2–S3) |
| `EmptyState` | — | `icon`, `title`, `body`, `action?` | `.empty`, `.empty-icon` |
| `Skeleton` | — | `lines?`, `width?` | `.skeleton` |
| `Spinner` | — | `label` | `.spin` |

Xuất qua `design-system/index.ts` (entry-point rule T00-02). Không primitive nào import `features/*` hay `lib/*`.

### 4.3 AppShell và layout

```tsx
// app/AppShell.tsx — Blueprint §3.6.2: props session, children; event onLogout; state default | offline
type SessionVM = { displayName: string; initials: string; roleLabel: string; roles: Array<"user"|"lead"|"manager"> };
export function AppShell({ session, onLogout, children }: { session: SessionVM; onLogout(): void; children: ReactNode })
```

- Header `.app-header` cao `--header-height` 56px: brand "Chat với tài liệu" → `/`; nav: "Hỏi đáp" `/`, "Lịch sử" `/history` (đề xuất, xem §10), "Nhật ký tài liệu" `/documents/audit` chỉ khi có `lead`, "Thống kê" `/stats` chỉ khi có `manager`; `aria-current="page"` cho mục hiện tại; dưới 1280px nhãn nav ẩn trực quan, giữ cho trình đọc màn hình (như `.nav-label` prototype).
- User chip: avatar chữ tắt, tên, nhãn vai trò (Chuyên viên BD / Trưởng nhóm BD / Quản lý), nút Đăng xuất (`IconButton` label "Đăng xuất") gọi `onLogout` (T01-03 nối `POST /auth/logout`).
- Skip link "Bỏ qua tới nội dung chính" → `#main`.
- Banner offline: hook `useOnlineStatus()` (`online`/`offline` event) → `Banner tone="warning"` "Mất kết nối. Câu hỏi của bạn vẫn được giữ lại." (Blueprint §3.6.4, EC-06). Hook đặt ở `lib/state` hoặc `lib/net` (đề xuất `lib/net/useOnlineStatus.ts`).
- `WorkspaceLayout` (`app/`): `div.workspace` grid `--sidebar-width minmax(0,1fr)`, thêm cột `--viewer-width` khi `viewerOpen` (class `.viewer-open`); slot `sidebar`, `main`, `viewer`. Dưới 1280px: sidebar thành drawer (`.sidebar.is-open`, nút "Kho tài liệu" `.only-narrow` có `aria-expanded`, đóng bằng Esc, focus trả về nút mở), viewer thành overlay toàn màn (UX-11). Trạng thái `sidebarOpen`, `viewerOpen` trong Zustand store `lib/state/layoutStore.ts`.
- Theme: tôn trọng `prefers-color-scheme`; `data-theme` trên `<html>` nếu người dùng chọn (lưu `localStorage` `cwd.theme`, bọc try/catch như `store` prototype).

### 4.4 Router

| Route | Thành phần | Bảo vệ |
|---|---|---|
| `/` | `WorkspaceLayout` + placeholder 3 vùng | user |
| `/c/:conversationId` | Như `/` (placeholder hiển thị id) | user |
| `/history` | Placeholder `EmptyState` "Chưa có hội thoại" (đề xuất) | user |
| `/documents/audit` | Placeholder | `RoleGuard role="lead"` → `/forbidden` |
| `/stats` | Placeholder | `RoleGuard role="manager"` → `/forbidden` |
| `/forbidden` | `EmptyState` icon `lock` "Bạn không có quyền truy cập trang này" + nút về trang chính | — |
| `/_design` | Trang trưng bày token/primitive (chỉ `import.meta.env.DEV`) | — |
| `*` | `NotFound` | — |

Route lead/manager được `lazy()` để không tải mã khi không dùng.

### 4.5 MSW (`src/mocks/`)

- `browser.ts`: `setupWorker(...handlers)`. Bật trong `main.tsx` khi `import.meta.env.DEV && import.meta.env.VITE_API_MOCK === "1"` bằng dynamic import (không vào bundle production). `npx msw init public/ --save` sinh `mockServiceWorker.js` — **loại khỏi build production** (cấu hình Vite `publicDir` copy có điều kiện hoặc xoá trong bước build — đề xuất).
- `server.ts`: `setupServer` cho Vitest.
- `fixtures/` chuyển từ `mock-data.js` sang TypeScript **đúng schema SAD §10.2** (snake_case, ISO-8601 UTC, UUID):

| Fixture | Từ prototype | Schema đích |
|---|---|---|
| `me.ts` | `ROLES` trong `common.js` (user/lead/manager) | `{id, display_name, email, roles[]}`; chọn bằng `?mock_role=lead` hoặc `localStorage cwd.mock.role` |
| `documents.ts` | `documents` (6 tài liệu, có `PROCESSING`, `FAILED scanned`, `unreadable_pages`) | `Document` (§10.2), `uploaded_by: {id, display_name}`, `uploaded_at` ISO |
| `conversations.ts` | `conversations` | `ConversationSummary`, `{id, title, messages: Message[]}` |
| `answers.ts` | `answers` (payment, warranty, price, team/partial, advice) + `classify()` | Chuỗi sự kiện SSE §10.3 |
| `audit.ts`, `weekly.ts` | `audit`, `weekly` | `AuditEntry`, `WeeklyStats` |

- Handlers (đều dưới `/api/v1`): `GET /me`; `GET /documents` (lọc `q` bỏ dấu dùng hàm `fold()` của prototype, `status`, `page_size`, `cursor`); `GET /documents/:id`; `POST /documents` (201 `QUEUED`, sau 3 s → `PROCESSING`, 8 s → `READY` để thử polling; 409 `DUPLICATE_DOCUMENT` khi trùng tên — mô phỏng sha256); `DELETE /documents/:id` (204 / 409 `ALREADY_REMOVED`); `POST /conversations`; `GET /conversations`; `GET /conversations/:id` (404 khi id lạ); `POST /conversations/:id/messages` trả `ReadableStream` `text/event-stream`: `meta` → `delta` (chia chữ ~20 ký tự mỗi 40 ms) → `citation` → `done`; nhánh `not_found` (chỉ `meta` + `done{answer_type:"not_found"}`), nhánh lỗi khi câu chứa "demo lỗi" (`error{code:"service_unavailable", retryable:true}`); `POST /events` 202; `GET /audit/documents` (403 nếu không lead); `GET /stats/weekly` (403 nếu không manager).
- Lỗi theo RFC 9457 (`application/problem+json`, đủ `type,title,status,code,detail,request_id`) — dùng chung helper `problem(code, status)`.
- `mocks/sse.ts`: `encodeSse(event, data)` → `event: <name>\ndata: <json>\n\n`; chèn `: ping\n\n` mỗi 15 s khi stream dài (để T02-06 test).

### 4.6 Truy vết hợp đồng

Kiểu TypeScript của fixture đặt ở `src/lib/api/types.ts` (`Document`, `Message`, `Citation`, `SseEvent`, `Problem`) để T01-03 dùng lại; mỗi kiểu có comment trỏ SAD §10.2/§10.3. Nếu SAD đổi, sửa ở một chỗ.

## 5. Các bước thực hiện

- [ ] Ngày 1: chép `tokens.css`, tách `base.css`/`components.css`; `Icon` + `Button`, `IconButton`, `Badge`, `Banner`, `Callout`, `EmptyState`, `Skeleton`, `Spinner`.
- [ ] Ngày 2: cài `@radix-ui/react-{dialog,toast,tooltip,checkbox}`; `Dialog`, `ConfirmDialog`, `Toast`, `Tooltip`, `Checkbox`; trang `/_design`.
- [ ] Ngày 3: `AppShell`, `WorkspaceLayout`, router, `RoleGuard`, `Forbidden`, `NotFound`, placeholder 3 vùng, responsive drawer/overlay, banner offline.
- [ ] Ngày 4: MSW (fixture, handlers, SSE), `lib/api/types.ts`; test §7; chụp màn hình 1440px, 1024px, 768px so với prototype; demo trong review.
- [ ] Kiểm tra CSP: chạy `npm run build && npm run preview` với header CSP của T00-07 (cấu hình `preview.headers` trong Vite) — ghi nhận vi phạm nếu có.

## 6. Tiêu chí hoàn thành

- [ ] `npm run dev` với `VITE_API_MOCK=1` hiển thị AppShell + workspace 3 vùng với dữ liệu mock; đổi `?mock_role=user|lead|manager` thì menu đổi đúng (WP-08).
- [ ] Ở 768–1279px: kho tài liệu thu gọn thành nút/drawer, vùng xem thành overlay; ở ≥ 1280px đủ 3 cột (NFR-007, UX-11).
- [ ] Người không có `lead` vào `/documents/audit` → `/forbidden`; không có `manager` vào `/stats` → `/forbidden`.
- [ ] Token khớp Blueprint §3.6.3 (light + dark); không còn mã màu hard-code trong `components.css` (kiểm bằng `grep -E "#[0-9A-Fa-f]{3,6}" src/design-system/components.css` rỗng; mọi mã màu chỉ nằm trong `tokens.css`).
- [ ] axe-core: 0 vi phạm mức serious/critical trên `/`, `/forbidden`, `/_design` (Blueprint §2.5, NFR-008).
- [ ] Bàn phím: Tab đi qua skip link → nav → user chip → nội dung; Dialog giữ focus và Esc đóng; focus ring hiển thị (`--color-focus-ring`).
- [ ] MSW trả đúng schema SAD §10.2 (test hợp đồng) và stream SSE đủ chuỗi `meta → delta → citation → done`.
- [ ] Bundle production không chứa MSW và fixture (kiểm `grep -r "msw" dist/` rỗng).

## 7. Kiểm thử

| Loại | Kịch bản | Kỳ vọng |
|---|---|---|
| Unit | `AppShell` với roles `["user"]` | Có "Hỏi đáp", "Lịch sử"; không có "Nhật ký tài liệu", "Thống kê" |
| Unit | roles `["user","lead"]` / `["user","manager"]` | Thêm đúng mục tương ứng |
| Unit | Bắn sự kiện `offline` | Banner `role="status"` với câu Blueprint §3.6.4 xuất hiện; `online` → ẩn |
| Unit | `ConfirmDialog` mở, nhấn Esc | `onCancel` được gọi, focus về nút mở |
| Unit | `Toast` | Tự ẩn sau 5 s (fake timer); có nút đóng |
| Unit | `Badge tone="failed"` | Có icon + chữ (không chỉ màu — UX-07) |
| Unit | `IconButton` thiếu `label` | Lỗi TypeScript (prop bắt buộc) |
| Unit (axe) | `vitest-axe` trên `AppShell` + `/_design` | 0 vi phạm serious/critical |
| Hợp đồng | Gọi handler MSW `GET /api/v1/documents?q=hop dong` qua `fetch` trong Vitest | Trả các tài liệu "HopDong_…", đúng kiểu `Document` (kiểm bằng type guard / zod schema) |
| Hợp đồng | `POST /conversations/c1/messages` câu "thanh toán" | Thứ tự sự kiện `meta, delta…, citation×2, done{answer_type:"answered", citation_count:2}` |
| Hợp đồng | Câu không khớp | `done{answer_type:"not_found"}` không có `delta` |
| Thủ công | So sánh ảnh chụp với `workspace.html` ở 1440/1024/768px | Khớp bố cục, màu, khoảng cách |

## 8. Analytics / observability

Không phát sự kiện ở task này (EV-xx do [T01-10](T01-10-analytics-events.md) và các story). Handler MSW `POST /events` trả 202 và in sự kiện ra console dev để các task sau kiểm tra payload. Không đưa nội dung câu hỏi vào bất kỳ log console nào ngoài chế độ mock.

## 9. Tham chiếu

- Blueprint_Design §2.5 (ràng buộc UX/UI), §3.1.2 (phân rã UI), §3.4.2 (luồng UF-01..UF-08), §3.6.2 (interface component), §3.6.3 (token), §3.6.4 (UX writing)
- Prototype: `docs/design/UI_UX_design/workspace.html`, `design-system.html`, `assets/tokens.css`, `assets/components.css`, `assets/common.js`, `assets/mock-data.js`
- SAD §4.1 (route, state, Radix, axe), §10.1–§10.3 (hợp đồng API, SSE), §11.1 (CSP)
- PRD NFR-007, NFR-008, UX-07, UX-11, EC-06
- IMPLEMENTATION_PLAN §3 (tái sử dụng prototype), §4 S0 WP-08

## 10. Giả định và câu hỏi mở

| Mục | Nội dung |
|---|---|
| Mâu thuẫn | SAD §4.1 không có route `/history`, nhưng Blueprint §3.1.2 có `features/history`, prototype có `history.html` và nav "Lịch sử". Đề xuất thêm `/history`; cần Architect cập nhật SAD §4.1 (US-017, T06-06). |
| Rủi ro CSP | Radix Dialog dùng `react-remove-scroll` chèn thẻ `<style>` lúc chạy → bị chặn bởi `default-src 'self'` khi không có `style-src`. Kiểm ở bước 5; nếu vi phạm, báo T00-07 và Bảo mật thông tin (phương án `style-src 'self' 'unsafe-inline'` hoặc nonce). |
| Đề xuất | Route `/_design` thay Storybook để tiết kiệm thời gian; có thể thêm Storybook sau nếu đội cần. |
| Đề xuất | Hook `useOnlineStatus` trong `lib/net/`; `RoleGuard` dùng hook `useMe()` tạm, T01-03 thay bằng client thật. |
| Đề xuất | Thư mục `src/mocks/` là vùng riêng trong ESLint boundaries (đã khai báo ở T00-02). |
| OQ-024 | WCAG 2.1 AA cho MVP — Blueprint giả định có; task này làm theo. |
| OQ-026 | Tên vai trò/nhãn hiển thị (Chuyên viên BD, Trưởng nhóm BD, Quản lý) theo prototype. |
| OQ-022 | Dưới 768px chỉ đảm bảo không vỡ (touch target 44px), không tối ưu điện thoại. |
