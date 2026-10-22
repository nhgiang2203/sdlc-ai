# T01-02 — CSRF, RBAC, rate limit, chuỗi middleware, `GET /me`

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S1 (09/11 – 20/11/2026) |
| Story / WP | US-001 · WP-10 |
| Loại | BE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-01](T01-01-oidc-session.md) |
| Chặn | [T01-03](T01-03-fe-auth-api-client.md), [T01-04](T01-04-document-upload-api.md), [T01-10](T01-10-analytics-events.md), [T02-01](T02-01-conversations-ownership.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Dựng chuỗi middleware chuẩn cho mọi request `/api/v1/*` theo SAD §4.4: xác thực phiên, chống CSRF, phân quyền theo vai trò, rate limit token bucket. Thêm endpoint `GET /api/v1/me`. Các endpoint ở sprint sau chỉ cần khai báo vai trò và hạn mức.

## 2. Bối cảnh

- SAD §4.4 quy định thứ tự middleware: request ID + tracing → giới hạn body → xác thực phiên → CSRF → RBAC → rate limit → validation → handler → chuẩn hoá lỗi RFC 9457.
- SAD §11.1: CSRF double-submit + kiểm tra `Origin`. RBAC gồm `user` / `lead` / `manager`.
- SAD §11.2: token bucket trong Valkey, 10 câu hỏi/phút và 60 câu hỏi/giờ mỗi người, 30 lượt tải lên/giờ mỗi người. **Thư viện rate limit viết ở task này**; T02-05 (câu hỏi) và T01-04 (tải lên) chỉ cấu hình.
- Request ID, tracing và bộ chuẩn hoá lỗi đã có từ T00-08. Phiên và `get_current_session` đã có từ T01-01.

## 3. Phạm vi

**Trong phạm vi:** middleware giới hạn body; CSRF; dependency `require_roles(...)`; thư viện `RateLimiterPort` + `ValkeyTokenBucket` (Lua) + dependency `rate_limit(policy)`; header `RateLimit-*`/`Retry-After`; `GET /api/v1/me`; `Cache-Control: no-store` cho `/api/v1/*`; test ma trận phân quyền tự sinh từ danh sách route; bật CSRF cho `POST /auth/logout`.

**Ngoài phạm vi:** semaphore 15 lời gọi Claude đồng thời (T02-05); các hạn mức cụ thể cho câu hỏi (T02-05 khai báo `QUESTION_POLICY`); xử lý 401 phía SPA (T01-03).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/entrypoints/api/middleware/body_limit.py` | Giới hạn theo route: `POST /api/v1/documents` 52.428.800 + 64 KB phần đầu multipart; `POST /api/v1/events` 256 KB; còn lại 64 KB (đề xuất). Vượt → 413 `PAYLOAD_TOO_LARGE` (với `/documents` mã là `FILE_TOO_LARGE`) |
| `backend/cwd/entrypoints/api/middleware/csrf.py` | Áp dụng cho `POST/PUT/PATCH/DELETE` trên `/api/v1/*` và `/auth/logout` |
| `backend/cwd/entrypoints/api/deps/authz.py` | `require_roles(*roles: Role)`; `CurrentUser` (user_id, roles, analytics_session_id) |
| `backend/cwd/ports/rate_limiter.py` | `RateLimiterPort`, `Bucket`, `Policy`, `Decision` |
| `backend/cwd/adapters/valkey/token_bucket.py` + `token_bucket.lua` | `ValkeyTokenBucket` |
| `backend/cwd/entrypoints/api/deps/rate_limit.py` | `rate_limit(policy)` dependency + gắn header |
| `backend/cwd/entrypoints/api/routers/me.py` | `GET /api/v1/me` |
| `backend/cwd/entrypoints/api/app.py` | Đăng ký middleware đúng thứ tự; mọi router `/api/v1` mặc định `Depends(require_roles("user"))` |

### 4.2 CSRF

1. Với các method thay đổi trạng thái: header `Origin` phải bằng `APP_ORIGIN` (ví dụ `https://cwd.staging.local`). Nếu thiếu `Origin` thì dùng `Referer` có cùng origin. Cả hai cùng thiếu → từ chối.
2. Header `X-CSRF-Token` phải khớp cookie `cwd_csrf`, **và** khớp `csrf_token` lưu trong phiên. So sánh bằng `hmac.compare_digest`.
3. Sai → 403 `CSRF_FAILED` (đề xuất mã), log `security.csrf_rejected` (route, không log token).
4. `GET/HEAD/OPTIONS` không kiểm tra. **Không** có route `GET` nào được thay đổi trạng thái.

### 4.3 RBAC

| Vai trò | Endpoint (theo SAD §4.4) |
|---|---|
| Công khai | `/auth/login`, `/auth/callback`, `/healthz`, `/readyz` |
| Đã đăng nhập (mọi vai trò) | `/auth/logout` |
| `user` | `/api/v1/me`, `/documents*`, `/conversations*`, `/messages*`, `/events` |
| `lead` | `/api/v1/audit/documents` (T05-05) |
| `manager` | `/api/v1/stats/weekly` (T06-01) |

- Không có phiên → 401 (`UNAUTHENTICATED` hoặc `SESSION_EXPIRED`, do T01-01 phân biệt). Thiếu vai trò → 403 `FORBIDDEN`. Body không chứa dữ liệu nghiệp vụ.
- Route mới **bắt buộc** khai báo vai trò. Test (§7) quét `app.routes`, route nào thiếu khai báo thì fail.

### 4.4 Rate limit (token bucket)

```python
@dataclass(frozen=True)
class Bucket:  name: str; capacity: int; refill_per_s: float
@dataclass(frozen=True)
class Policy:  name: str; buckets: tuple[Bucket, ...]
@dataclass(frozen=True)
class Decision: allowed: bool; limit: int; remaining: int; retry_after_s: int

class RateLimiterPort(Protocol):
    async def consume(self, policy: Policy, subject: str, cost: int = 1) -> Decision: ...

UPLOAD_POLICY   = Policy("upload",   (Bucket("h", 30, 30/3600),))
QUESTION_POLICY = Policy("question", (Bucket("m", 10, 10/60), Bucket("h", 60, 60/3600)))  # dùng ở T02-05
EVENTS_POLICY   = Policy("events",   (Bucket("m", 60, 1.0),))                            # đề xuất, T01-10
```

- Khoá Valkey: `rl:{policy}:{bucket}:{user_id}`, hash `{tokens, ts}`, `PEXPIRE` = thời gian nạp đầy × 2.
- Script Lua kiểm tra **mọi** bucket trước. Chỉ khi tất cả đủ token mới trừ. Toàn bộ chạy nguyên tử trong một `EVALSHA`. Đồng hồ lấy bằng `redis.call('TIME')` để các replica không lệch giờ nhau.
- Kết quả: `limit`/`remaining` lấy theo bucket chặt nhất; `retry_after_s = ceil((cost − tokens)/refill)` của bucket thiếu token lâu nhất.
- Header luôn gửi: `RateLimit-Limit`, `RateLimit-Remaining`. Khi bị chặn: 429 `RATE_LIMITED` (đề xuất mã) + `Retry-After` + problem `detail` "Bạn đang thao tác quá nhanh. Vui lòng thử lại sau {s} giây.".
- Valkey lỗi → **cho qua** (fail-open), log `warning` và tăng `cwd_ratelimit_errors_total`. Lý do: Valkey lỗi thì phiên cũng không dùng được, nên không mở thêm lỗ hổng (đề xuất).

### 4.5 `GET /api/v1/me`

```json
200 { "id": "0192…", "display_name": "Nguyễn Thu Hà", "email": "ha.nt@corp.vn", "roles": ["user","lead"] }
401 application/problem+json { "type": "…/unauthenticated", "title": "Chưa đăng nhập", "status": 401, "code": "UNAUTHENTICATED"|"SESSION_EXPIRED", "request_id": "…" }
```

Lấy `display_name`, `email` từ `access.users`, `roles` từ phiên. `Cache-Control: no-store`.

## 5. Các bước thực hiện

- [ ] Viết `body_limit.py` (kiểm tra `Content-Length` và đếm byte khi stream; thiếu `Content-Length` vẫn bị cắt khi vượt).
- [ ] Viết `csrf.py` và cấu hình `APP_ORIGIN`.
- [ ] Viết `require_roles`, gắn mặc định cho router `/api/v1`. Ghi đè bằng `public=True` cho route công khai.
- [ ] Viết `token_bucket.lua` và `ValkeyTokenBucket` (nạp script một lần, gặp `NOSCRIPT` thì nạp lại).
- [ ] Viết dependency `rate_limit(policy)` + middleware gắn header vào response.
- [ ] Viết `GET /api/v1/me`.
- [ ] Thêm middleware `Cache-Control: no-store` cho `/api/v1/*` và `/auth/*`.
- [ ] Viết test ma trận phân quyền (`tests/authz/test_route_matrix.py`).
- [ ] Ghi tài liệu cách khai báo vai trò và hạn mức cho route mới vào `backend/README.md`.

## 6. Tiêu chí hoàn thành

- [ ] Hỗ trợ AC-US001-3 (AC ánh xạ ở T01-03): không có cookie hoặc phiên đã hết hạn → **mọi** route `/api/v1/*` trả 401 problem+json, không có dữ liệu tài liệu hay hội thoại; test tự sinh cho mọi route đã đăng ký. Phía SPA chuyển tới đăng nhập ở T01-03.
- [ ] Request thay đổi trạng thái thiếu hoặc sai `X-CSRF-Token`, hoặc sai `Origin` → 403 `CSRF_FAILED`.
- [ ] `bd.user` gọi route của `lead`/`manager` → 403. `bd.lead` gọi route `lead` → 200 (dùng route giả trong test cho tới T05-05).
- [ ] Token bucket: 31 lượt tải lên trong một giờ → lượt thứ 31 nhận 429 với `Retry-After` > 0. Hai replica API dùng chung hạn mức.
- [ ] `GET /me` trả đúng schema SAD §10.2. Mọi phản hồi `/api/v1/*` có `Cache-Control: no-store`.
- [ ] Thứ tự middleware đúng SAD §4.4 (test kiểm tra: request chưa đăng nhập và sai CSRF nhận 401, không phải 403).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | Lua token bucket (Valkey Testcontainers): bucket đầy → 10 lượt OK, lượt 11 bị chặn, `retry_after_s` = 6; sau 6 s nạp lại 1 token; policy 2 bucket: bucket giờ hết thì chặn dù bucket phút còn; lượt bị chặn không trừ token |
| Unit | So khớp `Origin`: đúng; khác scheme; khác port; thiếu `Origin`, `Referer` đúng; cả hai thiếu |
| Integration | 50 request đồng thời (`asyncio.gather`) với capacity 30 → đúng 30 lượt được cho qua |
| Integration | Ma trận: với mọi `route × {ẩn danh, user, lead, manager}` → mã mong đợi (401/403/2xx/4xx nghiệp vụ). Route thiếu khai báo vai trò thì test fail |
| Integration | Body 300 KB tới `POST /api/v1/events` → 413; JSON 70 KB tới route mặc định → 413; JSON 70 KB tới `/events` → qua |
| Integration | Valkey dừng → rate limit fail-open, log cảnh báo (phiên lỗi → 503 do T01-01) |

## 8. Analytics / observability

- Metric: `cwd_ratelimit_rejections_total{policy}`, `cwd_ratelimit_errors_total`, `cwd_csrf_rejections_total`, `cwd_authz_denied_total{required_role}`.
- Log `security.*` mức `audit` khi bị từ chối CSRF hoặc 403, có `user_id`, `route`, `request_id`.
- Không có sự kiện EV mới.

## 9. Tham chiếu

SAD §4.4 (thứ tự middleware, bảng router), §10.1 (header rate limit, problem+json), §10.2 (`/me`), §11.1 (CSRF, RBAC), §11.2 (rate limiting); USER_STORIES §1 (hạn mức dùng chung), US-001.

## 10. Giả định và câu hỏi mở

- Giả định: SPA và API cùng origin sau Nginx, nên không cần CORS. Nếu khác origin thì phải xem lại `SameSite` và CSRF.
- Mã lỗi `CSRF_FAILED`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE` là đề xuất. SAD §10.2 chưa liệt kê. Cần chốt để FE (T01-03) ánh xạ thông điệp.
- **OQ-104:** Khi Valkey lỗi, rate limit fail-open hay fail-closed? Đề xuất fail-open (§4.4). Cần Bảo mật thông tin xác nhận.
- **OQ-105:** Hạn mức cho `POST /api/v1/events` (đề xuất 60 request/phút/người) chưa có trong SAD.
