# T01-03 — FE: API client, guard, Forbidden, giữ bản nháp khi hết phiên

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-001 · WP-10 |
| Loại | FE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T00-10](T00-10-design-system-appshell.md) (AppShell, design-system, MSW), [T01-02](T01-02-csrf-rbac-ratelimit-me.md) (hợp đồng `/me`, mã lỗi, CSRF) |
| Chặn | [T01-08](T01-08-fe-upload-dropzone.md), [T01-09](T01-09-fe-document-sidebar.md), [T02-06](T02-06-fe-chat-composer-stream.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Xây lớp hạ tầng client mà mọi feature sau dùng lại: `apiFetch` (CSRF, problem+json, xử lý 401), guard route theo phiên và vai trò, trang Forbidden, các màn hình "Phiên đã hết hạn" / "Đã đăng xuất", cơ chế giữ bản nháp câu hỏi trong `sessionStorage` qua hết phiên.

## 2. Bối cảnh

- SAD §4.1 (routing, server state, UI state), §8.4 bước 1 (SPA nhận 401 → `/auth/login?return_to=…`), §9.3 (SPA giữ bản nháp rồi chuyển hướng); Blueprint §3.1.2 (`features/auth`, `lib/api`, `lib/state`), §3.5.2 (`session`, `composerDraft`, quy tắc riêng tư phía client), §3.6.4 (UX writing).
- Prototype: [login.html](../../design/UI_UX_design/login.html) có 4 trạng thái `login`, `expired`, `forbidden`, `logged_out`; [common.js](../../design/UI_UX_design/assets/common.js) có `store.sget/sset/sdel` (bọc try/catch) và `renderHeader` (user chip, nút đăng xuất, menu theo vai trò).
- Ô soạn câu hỏi làm ở T02-06. Task này chỉ cung cấp **cơ chế** bản nháp (`useDraft`) và hợp đồng cho T02-06.

## 3. Phạm vi

**Trong phạm vi:** `lib/api/{client,problem,csrf,types,mappers}.ts`; `lib/auth/{redirect,authEvents}.ts`; `lib/state/draftStore.ts`; `features/auth/*` (useMe, RequireAuth, RequireRole, ForbiddenPage, AuthStatusPage, useLogout, UserChip); route `/forbidden`, `/login`; xử lý bfcache khi bấm Back; handler MSW cho `/me` và `/auth/logout`.

**Ngoài phạm vi:** ô soạn và gửi câu hỏi (T02-06); hàng đợi analytics (T01-10, task này chỉ gọi `track`); đọc SSE (T02-06); trang Audit/Stats (T05-06, T06-02, chỉ dùng `RequireRole`).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc file

| File | Nội dung |
|---|---|
| `frontend/src/lib/api/client.ts` | `apiFetch<T>(path, opts)`; `opts = {method?, json?, body?, signal?, background?: boolean}` |
| `frontend/src/lib/api/problem.ts` | `class ApiError extends Error {status; code; title; detail?; requestId?; retryAfterS?; extra}`; `parseProblem(res)` |
| `frontend/src/lib/api/csrf.ts` | `readCsrfToken()`: đọc cookie `cwd_csrf` |
| `frontend/src/lib/api/types.ts` | `MeDto`, `ProblemDto`, (T01-07 bổ sung `DocumentDto`) |
| `frontend/src/lib/api/mappers.ts` | `toSessionVM(me: MeDto): SessionVM` (Blueprint §3.2.2: `canViewAudit = roles.includes("lead")`, `canViewStats = roles.includes("manager")`) |
| `frontend/src/lib/auth/redirect.ts` | `currentReturnTo()`, `goToLogin(returnTo)`, `goToSessionExpired(returnTo)` |
| `frontend/src/lib/auth/authEvents.ts` | Event bus nhỏ: `onUnauthorized(cb)`, `emitUnauthorized(code)`. Gọi `emit` một lần duy nhất cho mỗi lượt hết phiên (có cờ chống lặp) |
| `frontend/src/lib/state/draftStore.ts` | `useDraft(key)`, `readDraft`, `writeDraft`, `clearDraft`, `clearAllDrafts` |
| `frontend/src/features/auth/useMe.ts` | `useQuery(["me"], …)`, `staleTime: 5 phút`, `retry: false` khi 401 |
| `frontend/src/features/auth/RequireAuth.tsx` | Bọc các route sau đăng nhập; `loading` → skeleton AppShell; 401 → chuyển hướng |
| `frontend/src/features/auth/RequireRole.tsx` | `role: "lead" \| "manager"`; thiếu vai trò → `<Navigate to="/forbidden?scope=role" />` |
| `frontend/src/features/auth/ForbiddenPage.tsx` | 2 biến thể: `scope=app` (không thuộc nhóm), `scope=role` (thiếu vai trò lead/manager) |
| `frontend/src/features/auth/AuthStatusPage.tsx` | `/login?reason=expired\|logged_out\|error` |
| `frontend/src/features/auth/useLogout.ts` | Mutation `POST /auth/logout` |
| `frontend/src/features/auth/UserChip.tsx` | Avatar chữ cái đầu, tên, vai trò, nút đăng xuất (theo `renderHeader` của prototype) |
| `frontend/src/app/router.tsx` | Khai báo route (§4.3) |
| `frontend/src/mocks/handlers/auth.ts` | MSW: `/me` theo kịch bản `?mock=user\|lead\|manager\|anon\|expired` |

### 4.2 `apiFetch`

1. `credentials: "same-origin"`, `Accept: application/json`. Có `json` thì `Content-Type: application/json`.
2. Method khác `GET/HEAD` thì gắn `X-CSRF-Token: readCsrfToken()`.
3. `background: true` thì gắn `X-CWD-Background: 1`, để polling và gửi analytics không gia hạn phiên (T01-01 §4.2).
4. Response `!ok`: `parseProblem` → `ApiError`. Đọc `Retry-After` vào `retryAfterS`.
5. Gặp 401 `SESSION_EXPIRED` hoặc `UNAUTHENTICATED` khi đang ở route cần đăng nhập → `emitUnauthorized(code)`, rồi vẫn `throw` để caller dừng.
6. Lỗi mạng (`TypeError`) → `ApiError{status: 0, code: "NETWORK_ERROR"}`.

Bộ xử lý toàn cục trong `app/providers.tsx` lắng nghe `onUnauthorized`:
- `SESSION_EXPIRED` → bản nháp đã lưu sẵn (§4.4) → `track("access_denied", {reason: "session_expired"})` (sự kiện được giữ lại tới khi đăng nhập lại, xem T01-10) → `queryClient.clear()` → `location.assign("/login?reason=expired&return_to=" + encodeURIComponent(currentReturnTo()))`.
- `UNAUTHENTICATED` → `location.assign("/auth/login?return_to=…")`, chuyển thẳng không qua màn hình trung gian.

### 4.3 Route

| Route | Bảo vệ | Màn hình |
|---|---|---|
| `/`, `/c/:conversationId` | `RequireAuth` | Workspace (T00-10, T01-09, S2) |
| `/documents/audit` | `RequireAuth` + `RequireRole role="lead"` | T05-06 |
| `/stats` | `RequireAuth` + `RequireRole role="manager"` | T06-02 |
| `/forbidden` | Công khai, **không gọi API** | ForbiddenPage |
| `/login` | Công khai, **không gọi API** | AuthStatusPage (route mới, đề xuất; SAD §4.1 chưa có) |

**ForbiddenPage** (`scope=app`, nội dung lấy từ prototype): biểu tượng khoá; tiêu đề "Bạn chưa được cấp quyền sử dụng"; "Tài khoản của bạn đã đăng nhập thành công nhưng chưa thuộc nhóm được phép dùng công cụ này."; "Liên hệ trưởng nhóm Phát triển kinh doanh hoặc bộ phận IT để được cấp quyền."; nút phụ "Đăng nhập bằng tài khoản khác" → `/auth/login`. Trang không render AppShell, không có tên tài liệu, không dùng TanStack Query.

**AuthStatusPage:**

| `reason` | Tiêu đề | Thân | Nút |
|---|---|---|---|
| `expired` | Phiên đăng nhập đã hết hạn | Callout info: "Câu hỏi bạn đang soạn vẫn được giữ lại và sẽ hiện lại sau khi đăng nhập." | "Đăng nhập lại" → `/auth/login?return_to=` |
| `logged_out` | Bạn đã đăng xuất | "Dữ liệu phiên đã được xoá khỏi trình duyệt này." | "Đăng nhập lại" |
| `error` | Không đăng nhập được | "Đã có lỗi khi đăng nhập qua tài khoản công ty. Vui lòng thử lại." (đề xuất) | "Thử lại" |

`return_to` được kiểm tra lại phía client: phải bắt đầu bằng `/`, không bắt đầu bằng `//`.

### 4.4 Bản nháp câu hỏi (`draftStore`)

- Khoá: `cwd.draft.<conversationId|new>` (Blueprint §3.5.2). Mọi thao tác bọc `try/catch`. Nếu `sessionStorage` bị chặn thì dùng bản trong bộ nhớ (không lỗi).
- `useDraft(key)` → `[value, setValue, clear]`. `setValue` ghi `sessionStorage` (debounce 300 ms, flush ngay ở `pagehide` và trước `emitUnauthorized`).
- **Hợp đồng cho T02-06:** (a) composer dùng `useDraft`; (b) **không xoá** bản nháp khi bấm Gửi, chỉ xoá khi nhận sự kiện SSE `meta`, tức là server đã nhận câu hỏi; (c) nhận 401 khi gửi thì bản nháp vẫn còn. Sau khi đăng nhập lại và quay về `return_to`, composer hiện lại câu hỏi. Người dùng bấm Gửi lại, **không tự gửi** (đề xuất, xem OQ-106). Có toast info "Câu hỏi của bạn đã được giữ lại. Bấm Gửi để gửi lại." khi có bản nháp được khôi phục sau `reason=expired`.
- Khi đăng xuất: `clearAllDrafts()` xoá mọi khoá `cwd.draft.*` (quy tắc riêng tư Blueprint §3.5.2).

### 4.5 Đăng xuất và nút Back (AC-US001-6)

1. `useLogout`: `POST /auth/logout` → `clearAllDrafts()` → `queryClient.clear()` → `location.replace("/login?reason=logged_out")`. Dùng `replace` để lịch sử không còn mục trang làm việc trên cùng.
2. `app/main.tsx`: lắng nghe `pageshow`. Nếu `event.persisted` (trang được khôi phục từ bfcache) thì `queryClient.clear()` và `refetch` `/me`. Nhận 401 → guard chuyển hướng. Trước khi `/me` trả về, `RequireAuth` render skeleton chứ không render dữ liệu cũ.
3. API đã có `Cache-Control: no-store` (T01-02). `index.html` do Nginx phục vụ `no-cache` (SAD §4.1).

## 5. Các bước thực hiện

- [ ] Viết `problem.ts`, `csrf.ts`, `client.ts` và unit test.
- [ ] Viết `authEvents.ts`, `redirect.ts`, bộ xử lý toàn cục trong `app/providers.tsx`.
- [ ] Viết `draftStore.ts` + hook `useDraft` và unit test.
- [ ] Viết `useMe`, `toSessionVM`, `RequireAuth`, `RequireRole`. Nối `SessionVM` vào `AppShell` (prop `session`) và `UserChip`.
- [ ] Viết `ForbiddenPage`, `AuthStatusPage` bằng primitive `EmptyState`/`Button`/`Callout` của design-system.
- [ ] Viết `useLogout` và xử lý `pageshow`.
- [ ] Viết handler MSW cho các kịch bản `/me`. Viết component `DraftHarness` chỉ dùng trong test để kiểm tra cơ chế nháp trước khi có composer.
- [ ] Viết E2E Playwright với Keycloak trên CI (`e2e/auth.spec.ts`).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US001-2:** đăng nhập bằng `outsider` → thấy "Bạn chưa được cấp quyền sử dụng" + hướng dẫn liên hệ; DOM và network không có tên tài liệu nào (Playwright kiểm tra không có request `/api/v1/documents`).
- [ ] **AC-US001-3:** chưa đăng nhập, mở trực tiếp `/c/<uuid>` hoặc `/?doc=<id>` → chuyển tới IdP với `return_to` đúng; sau khi đăng nhập quay về đúng URL; trong lúc chờ không có nội dung nào được render. Phía server xem T01-02.
- [ ] **AC-US001-4 (cơ chế):** gõ nội dung trong `DraftHarness` → làm hết phiên (xoá khoá Valkey) → thao tác tiếp nhận 401 `SESSION_EXPIRED` → thấy màn hình "Phiên đăng nhập đã hết hạn" → đăng nhập lại → nội dung còn nguyên. Hành vi trên ô hỏi thật được T02-06 kiểm tra lại.
- [ ] **AC-US001-6:** đăng xuất → bấm Back → không thấy dữ liệu nào (kể cả từ bfcache) và được chuyển tới đăng nhập.
- [ ] Menu "Nhật ký tài liệu" chỉ hiện với `lead`, "Thống kê" chỉ hiện với `manager`. Vào thẳng `/stats` khi chỉ có vai trò `user` → `/forbidden?scope=role`.
- [ ] axe-core không có lỗi nghiêm trọng trên `/forbidden` và `/login`.

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit (Vitest) | `apiFetch`: gắn CSRF cho POST, không gắn cho GET; `background` gắn header; parse problem+json; 429 đọc `Retry-After`; lỗi mạng → `NETWORK_ERROR`; 401 phát `emitUnauthorized` đúng một lần khi có 3 request song song |
| Unit | `draftStore`: ghi/đọc/xoá; `sessionStorage` ném lỗi → vẫn chạy bằng bộ nhớ; `clearAllDrafts` chỉ xoá khoá `cwd.draft.*` |
| Unit | `toSessionVM`; `RequireRole` với từng vai trò (Testing Library + MSW) |
| E2E | Luồng đăng nhập 4 user Keycloak; deep link khi chưa đăng nhập; hết phiên giữa chừng (script xoá `sess:*` trong Valkey); đăng xuất + Back; `return_to=//evil.com` → về `/` |
| A11y | axe-core cho `/forbidden`, `/login?reason=expired` |

## 8. Analytics / observability

- Client phát EV-02 `access_denied` `{reason: "session_expired"}` khi nhận `SESSION_EXPIRED`. Sự kiện được T01-10 giữ trong hàng đợi chờ (`sessionStorage`) và gửi sau khi đăng nhập lại.
- EV-01 và EV-02 `not_authorized` ghi phía server (T01-01), client không phát.
- Lỗi `apiFetch` (trừ 401/403/429) ghi `console.error` kèm `request_id` để đối chiếu log server.

## 9. Tham chiếu

SAD §4.1, §8.4, §9.3, §10.1, §11.1; Blueprint §3.1.2, §3.2.2 (`SessionVM`), §3.5.2, §3.6.2 (`AppShell`), §3.6.4; prototype `login.html`, `assets/common.js`; PRD EC-19, EC-20; USER_STORIES US-001.

## 10. Giả định và câu hỏi mở

- Giả định: SPA và API cùng origin. Cookie `cwd_csrf` đọc được bằng `document.cookie`.
- Route `/login` là đề xuất của task này, chưa có trong danh sách route SAD §4.1. Cần cập nhật SAD.
- **OQ-106:** AC-US001-4 ghi "giữ nguyên câu hỏi đang soạn để **gửi lại** sau khi đăng nhập". Hệ thống chỉ khôi phục vào ô soạn để người dùng tự bấm Gửi, hay tự động gửi? Đề xuất không tự gửi, để tránh gửi câu hỏi vào hội thoại hoặc phạm vi mà người dùng không còn nhớ. PO cần xác nhận.
