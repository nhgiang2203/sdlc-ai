# T01-01 — Đăng nhập OIDC + phiên trong Valkey

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-001 · WP-10 |
| Loại | BE |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T00-04](T00-04-db-baseline-migration.md) (`access.users`), [T00-08](T00-08-logging-tracing-errors.md) (log, trace, RFC 9457) |
| Chặn | [T01-02](T01-02-csrf-rbac-ratelimit-me.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Người dùng đăng nhập bằng SSO công ty qua OIDC Authorization Code + PKCE tại BFF. Sau khi đăng nhập, phiên được lưu trong Valkey và trình duyệt chỉ giữ cookie `HttpOnly`, không giữ token. Phiên hết hạn sau 30 phút không hoạt động hoặc 8 giờ kể từ khi đăng nhập.

## 2. Bối cảnh

- ADR-007 (BFF + session cookie), SAD §8.4 (luồng đăng nhập 6 bước), §9.3 (vòng đời phiên), §11.1 (xác thực, phiên), IF-02 (§10.4).
- Dev/staging dùng Keycloak cục bộ (PA-04, T00-03). Khi có IdP thật (OQ-016) thì chỉ đổi cấu hình.
- Task này chỉ làm phần xác thực và phiên. CSRF, RBAC, chuỗi middleware và `GET /me` thuộc T01-02.

## 3. Phạm vi

**Trong phạm vi:** `IdentityPort` + `OIDCIdentity` (Authlib); `SessionStorePort` + `ValkeySessionStore`; `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`; ánh xạ claim nhóm sang vai trò; upsert `access.users`; cookie phiên, xoay ID; dependency `get_current_session` (dùng lại ở T01-02); log audit đăng nhập; ghi sự kiện server EV-01, EV-02 `not_authorized` qua `AnalyticsPort` (no-op cho tới khi T01-10 xong).

**Ngoài phạm vi:** cookie/kiểm tra CSRF, RBAC, `GET /me`, rate limit (T01-02); trang Forbidden, chuyển hướng phía SPA, giữ bản nháp (T01-03); bảng và endpoint analytics (T01-10); RP-initiated logout tại IdP (OQ-101).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/domain/access/roles.py` | `Role = Literal["user","lead","manager"]`; `map_groups_to_roles(groups, mapping) -> frozenset[Role]` (thuần, không I/O) |
| `backend/cwd/domain/access/session.py` | `Session` (dataclass frozen): `sid`, `user_id`, `roles`, `created_at`, `last_seen_at`, `abs_expires_at`, `csrf_token`, `analytics_session_id` |
| `backend/cwd/ports/identity.py` | `IdentityPort` (bên dưới) |
| `backend/cwd/ports/session_store.py` | `SessionStorePort` |
| `backend/cwd/ports/repositories.py` | thêm `UserRepository.upsert_by_subject(...) -> UUID` |
| `backend/cwd/adapters/identity/oidc.py` | `OIDCIdentity` (Authlib `AsyncOAuth2Client`, discovery, JWKS cache 1 giờ) |
| `backend/cwd/adapters/valkey/session_store.py` | `ValkeySessionStore` |
| `backend/cwd/adapters/postgres/user_repository.py` | `PgUserRepository` |
| `backend/cwd/application/access/login.py` | `StartLogin`, `CompleteLogin`, `Logout` |
| `backend/cwd/entrypoints/api/routers/auth.py` | 3 route `/auth/*` |
| `backend/cwd/entrypoints/api/deps/session.py` | `get_current_session(request) -> Session` (raise 401) |

```python
class IdentityPort(Protocol):
    async def begin(self, redirect_uri: str) -> AuthRequest: ...
        # AuthRequest(url, state, nonce, code_verifier)
    async def complete(self, code: str, pending: AuthRequest, redirect_uri: str) -> IdentityClaims: ...
        # IdentityClaims(subject, display_name, email, groups: list[str]); raise IdentityError

class SessionStorePort(Protocol):
    async def put_pending_auth(self, state: str, data: PendingAuth, ttl_s: int = 600) -> None: ...
    async def pop_pending_auth(self, state: str) -> PendingAuth | None: ...   # GETDEL, chỉ dùng 1 lần
    async def create(self, user_id: UUID, roles: frozenset[Role]) -> Session: ...
    async def get(self, sid: str) -> Session | None: ...
    async def touch(self, sid: str) -> None: ...          # cập nhật last_seen_at + EXPIRE
    async def delete(self, sid: str) -> None: ...
```

### 4.2 Dữ liệu trong Valkey

| Khoá | Kiểu | Nội dung | TTL |
|---|---|---|---|
| `oidc:pending:{state}` | string JSON | `nonce`, `code_verifier`, `return_to`, `created_at` | 600 s |
| `sess:{sid}` | hash | `user_id`, `roles` (JSON), `created_at`, `last_seen_at`, `abs_expires_at`, `csrf_token`, `analytics_session_id`, `is_first_session` | `min(1800, abs_expires_at − now)`, đặt lại mỗi lần `touch` |

- `sid` = `secrets.token_urlsafe(32)` (256 bit). `csrf_token` = `secrets.token_urlsafe(32)`. `analytics_session_id` = UUID v7, không phải bí mật, dùng cho cột `session_id` của analytics (T01-10). **Không bao giờ ghi `sid` vào log hay analytics.**
- `get`: không có khoá → `None`. Có khoá nhưng `now ≥ abs_expires_at` → xoá khoá, trả `None`.
- **Request nền không gia hạn phiên (đề xuất):** request có header `X-CWD-Background: 1` (polling danh sách tài liệu, gửi lô analytics) chỉ đọc phiên, không gọi `touch`. Nếu không làm vậy, polling 5 s (T01-09) sẽ giữ phiên sống mãi và AC-US001-5 không đạt.

### 4.3 Endpoint

| Endpoint | Xử lý | Kết quả |
|---|---|---|
| `GET /auth/login?return_to=/c/abc` | Chuẩn hoá `return_to`: chỉ chấp nhận đường dẫn tương đối bắt đầu bằng `/`, không bắt đầu bằng `//` hoặc `/\`, ≤ 512 ký tự; sai thì dùng `/`. Gọi `IdentityPort.begin`, lưu `oidc:pending:{state}` | 302 tới `authorization_endpoint` (`response_type=code`, `scope=openid profile email`, `code_challenge_method=S256`, `state`, `nonce`) |
| `GET /auth/callback?code&state` | `pop_pending_auth(state)` (không có thì lỗi). Đổi `code` lấy token, kiểm tra `id_token`: chữ ký JWKS, `iss`, `aud`, `nonce`, `exp` (lệch giờ ≤ 60 s). Đọc claim nhóm (`OIDC_GROUPS_CLAIM`) → vai trò | Có `user`: upsert user, xoá phiên cũ nếu cookie có (xoay ID), tạo phiên mới, đặt cookie, 302 về `return_to`. Không có `user`: 302 `/forbidden`, ghi EV-02. Lỗi `state`/token/IdP `error=`: 302 `/login?reason=error` (đề xuất) |
| `POST /auth/logout` | Xoá `sess:{sid}`; đặt lại 2 cookie với `Max-Age=0`; header `Clear-Site-Data: "cache"` | 204. Gọi khi đã hết phiên vẫn trả 204 (idempotent). Kiểm tra CSRF thêm ở T01-02 |

**Cookie** (đặt trong callback):
- `__Host-cwd_session=<sid>; Path=/; HttpOnly; Secure; SameSite=Lax`. Không đặt `Max-Age`, là session cookie; hạn thật do Valkey quyết định.
- `cwd_csrf=<csrf_token>; Path=/; Secure; SameSite=Lax`, không `HttpOnly` để SPA đọc. T01-02 dùng cookie này.

**Ánh xạ vai trò** (cấu hình, chờ OQ-026): `ROLE_GROUP_USER=cwd-users`, `ROLE_GROUP_LEAD=cwd-leads`, `ROLE_GROUP_MANAGER=cwd-managers`. Theo SAD §8.4, **thiếu nhóm `cwd-users` thì không được truy cập**, kể cả khi có `cwd-leads`. Xem OQ-102.

**Upsert `access.users`:** `INSERT … ON CONFLICT (idp_subject) DO UPDATE SET display_name, email, roles, last_seen_at = now()`. Trả `id` và `is_first_session = (xmax = 0)`, tức là bản ghi vừa được tạo. Người không có quyền **không** được upsert (tối thiểu hoá dữ liệu, CON-006).

### 4.4 Cấu hình

| Biến | Giá trị dev | Ghi chú |
|---|---|---|
| `OIDC_ISSUER` | `http://keycloak:8080/realms/cwd` | Discovery `/.well-known/openid-configuration` |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET_FILE` | `cwd-bff` / `/run/secrets/oidc_client_secret` | Confidential client, secret đọc từ file (OQ-032) |
| `OIDC_REDIRECT_URI` | `https://localhost/auth/callback` | — |
| `OIDC_GROUPS_CLAIM` | `groups` | Keycloak: mapper "Group Membership", tắt full path |
| `OIDC_HTTP_TIMEOUT_S` | `10` | IF-02 |
| `SESSION_IDLE_TIMEOUT_S` / `SESSION_ABSOLUTE_TIMEOUT_S` | `1800` / `28800` | AC-US001-5 |

## 5. Các bước thực hiện

- [ ] Realm Keycloak dev `cwd` (export JSON trong `deploy/compose/keycloak/`): client `cwd-bff`, 3 nhóm, 4 user test: `bd.user` (cwd-users), `bd.lead` (users + leads), `bd.manager` (users + managers), `outsider` (không nhóm).
- [ ] Viết `roles.py`, `session.py` cùng unit test.
- [ ] Viết `IdentityPort`, `OIDCIdentity` (PKCE S256, kiểm tra `nonce`, cache JWKS và tải lại khi gặp `kid` lạ).
- [ ] Viết `ValkeySessionStore` (`HSET` + `EXPIRE` trong `MULTI`; `GETDEL` cho pending).
- [ ] Viết `PgUserRepository.upsert_by_subject`.
- [ ] Viết use case `StartLogin`, `CompleteLogin`, `Logout` và router `auth.py`.
- [ ] Viết dependency `get_current_session`: thiếu cookie → 401 `UNAUTHENTICATED`; có cookie nhưng phiên không còn → 401 `SESSION_EXPIRED`; còn phiên và không phải request nền → `touch`.
- [ ] Log audit `auth.login_succeeded` / `auth.login_failed` (`user_id` hoặc `reason`, không log token, `code`, `sid`).
- [ ] Gọi `AnalyticsPort.record("session_started", {is_first_session})` sau khi tạo phiên và `record("access_denied", {reason: "not_authorized"}, user_id=None)` khi bị từ chối.
- [ ] Viết integration test với Keycloak (Testcontainers) và cập nhật `docs/api` (OpenAPI).

## 6. Tiêu chí hoàn thành

- [ ] **AC-US001-1:** `bd.user` đăng nhập qua Keycloak thì được 302 về `/` với cookie `__Host-cwd_session` hợp lệ; request tiếp theo dùng cookie đó xác thực được (E2E vào màn hình chính xác nhận ở T01-09).
- [ ] **AC-US001-5:** phiên không hoạt động quá 30 phút → 401 `SESSION_EXPIRED`; phiên quá 8 giờ dù vẫn hoạt động → 401 `SESSION_EXPIRED`; request có `X-CWD-Background: 1` không kéo dài thời hạn.
- [ ] `outsider` được chuyển tới `/forbidden`, không có cookie phiên, không có bản ghi `access.users` (hỗ trợ AC-US001-2 ở T01-03).
- [ ] Sau `POST /auth/logout`, khoá `sess:*` bị xoá; dùng lại cookie cũ → 401 (hỗ trợ AC-US001-6 ở T01-03).
- [ ] `return_to` tuyệt đối hoặc `//evil.com` bị thay bằng `/` (chống open redirect).
- [ ] Trình duyệt không nhận token IdP nào (kiểm tra cookie và body phản hồi).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | `map_groups_to_roles`: `[cwd-users]`→{user}; `[cwd-users,cwd-leads]`→{user,lead}; `[cwd-leads]` → không có `user` → bị từ chối; nhóm lạ bị bỏ qua |
| Unit | Chuẩn hoá `return_to`: `/c/1?x=2` giữ nguyên; `https://a.b`, `//a.b`, `/\a.b`, chuỗi rỗng, chuỗi 600 ký tự → `/` |
| Unit | `ValkeySessionStore` với fakeredis và đồng hồ giả: TTL trượt, cắt theo `abs_expires_at`, `get` sau 8 giờ trả `None` |
| Integration | Keycloak + Valkey + PostgreSQL (Testcontainers): luồng đầy đủ bằng `httpx` (theo redirect, submit form login) cho 4 user; `state` sai → `/login?reason=error`; dùng lại `state` lần hai → lỗi; `nonce` sai (giả lập) → lỗi |
| Integration | Xoay ID: đăng nhập lần hai với cookie cũ → `sid` mới khác, khoá cũ bị xoá |
| Integration | Logout idempotent; cookie trả về có `Max-Age=0` |
| Bảo mật | Thuộc tính cookie đúng `__Host-`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, không có `Domain` |

## 8. Analytics / observability

- EV-01 `session_started` (`is_first_session`) và EV-02 `access_denied` (`reason=not_authorized`, `user_id = null`) ghi **phía server**, qua `AnalyticsPort` (đề xuất, xem OQ-103).
- Span `auth.callback` (thuộc tính: `outcome`, `idp_latency_ms`). Không gắn claim hay email vào span.
- Metric: `cwd_auth_logins_total{outcome=success|forbidden|error}`.
- Log mức `audit` cho đăng nhập thành công/thất bại (SAD §11.1).

## 9. Tham chiếu

SAD §4.4 (router `auth`), §8.4, §9.3, §10.4 IF-02, §11.1; ADR-007, ADR-010; USER_STORIES US-001; PRD EC-19, EC-20, §6.2 EV-01, EV-02.

## 10. Giả định và câu hỏi mở

- Giả định: IdP thật hỗ trợ discovery, PKCE S256 và trả nhóm trong `id_token` hoặc userinfo. Nếu nhóm chỉ có ở userinfo thì `OIDCIdentity` gọi thêm userinfo.
- **OQ-101:** Đăng xuất có cần kết thúc cả phiên SSO tại IdP (`end_session_endpoint`) không? Hiện tại chỉ xoá phiên ứng dụng, nên quay lại sẽ tự đăng nhập qua SSO mà không cần mật khẩu.
- **OQ-102:** Người thuộc `cwd-leads`/`cwd-managers` nhưng không thuộc `cwd-users` có được vào không? Thiết kế hiện tại theo SAD §8.4 là không. Cần IT xác nhận cách gán nhóm (gắn với OQ-026).
- **OQ-103:** PRD/IMPLEMENTATION_PLAN đặt EV-01 phát từ client. Task này đề xuất ghi phía server tại callback vì server biết `is_first_session`. EV-02 `not_authorized` buộc phải ghi phía server vì người bị từ chối không có phiên để gọi `/events`.
