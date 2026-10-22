# T06-01 — Thống kê tuần: materialized view, refresh, API

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | US-019, US-020 · WP-60 |
| Loại | BE |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T01-10](T01-10-analytics-events.md) (bảng `ops.analytics_events`, emitter EV-08/EV-09), [T01-02](T01-02-csrf-rbac-ratelimit-me.md) (RBAC vai trò `manager`) |
| Chặn | [T06-02](T06-02-fe-stats-page.md), [T07-03](T07-03-security-testing.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Cung cấp số liệu sử dụng theo tuần ISO (người dùng hoạt động, tổng người được cấp quyền, số câu hỏi, tỷ lệ "không tìm thấy", tỷ lệ hữu ích) qua materialized view `ops.weekly_stats` được làm mới mỗi giờ và endpoint `GET /api/v1/stats/weekly` chỉ dành cho vai trò `manager`. Số liệu phải khớp với kiểm đếm trực tiếp từ sự kiện EV-08 (AC-US019-2, AC-US020-2).

## 2. Bối cảnh

- MET-003 (WAU/tổng người được cấp quyền, KR3.1 ≥ 60%) và MET-004 (tỷ lệ hữu ích, KR3.2 ≥ 70%) là số liệu sponsor dùng để quyết định đầu tư sau pilot (J4, báo cáo 26/03/2027). LG-08 yêu cầu trang Thống kê hiển thị đúng.
- SAD §4.2 module `reporting` (`WeeklyStats`), §4.4 router `stats`, §7.2 `ops.weekly_stats` "Materialized view: WAU, số câu hỏi, tỷ lệ not_found, tỷ lệ hữu ích — refresh mỗi giờ", §4.2 tác vụ `refresh_weekly_stats()` (mỗi giờ, hàng đợi `maintenance`, timeout 5 phút), §10.2 hợp đồng endpoint, ADR-013 analytics tự lưu trong PostgreSQL.
- Định nghĩa chỉ số theo PRD §6.2: WAU = người dùng có ≥ 1 EV-08 trong tuần; tỷ lệ không tìm thấy = EV-09 `answer_type = not_found` ÷ tổng EV-09; tỷ lệ hữu ích = EV-17 `rating = up` ÷ tổng EV-17.

## 3. Phạm vi

**Trong phạm vi:**
- Migration Alembic tạo `ops.authorized_headcount` (đề xuất) và materialized view `ops.weekly_stats` + unique index.
- Celery task `refresh_weekly_stats` + lịch Celery beat mỗi giờ.
- Use case `GetWeeklyStats`, port, adapter Postgres, router `stats`, schema Pydantic.
- Script đối chiếu `backend/scripts/reconcile_weekly_stats.py`: so MV với đếm trực tiếp EV-08/EV-09/EV-17.
- Test unit, integration (Testcontainers), test phân quyền cho endpoint.

**Ngoài phạm vi:**
- Trang Thống kê, ẩn menu, EV-19 → [T06-02](T06-02-fe-stats-page.md).
- Ghi EV-17 → [T06-03](T06-03-answer-feedback.md); ghi EV-08/EV-09 → [T02-05](T02-05-ask-question-sse.md) qua emitter của [T01-10](T01-10-analytics-events.md).
- Dashboard Grafana đọc analytics → [T06-04](T06-04-metrics-dashboards-alerts.md).
- Xoá phân vùng analytics > 13 tháng (SAD §7.4) — chưa có task, xem §10.

## 4. Thiết kế chi tiết

### 4.1 File / module

| Lớp | File | Nội dung |
|---|---|---|
| domain | `backend/cwd/domain/reporting/iso_week.py` | Value object `IsoWeek` (parse/format `YYYY-Www`, so sánh, `range(from, to)`), kiểm tra hợp lệ (tuần 53) |
| domain | `backend/cwd/domain/reporting/weekly_stats.py` | Dataclass `WeeklyStatsRow(iso_week, authorized_users, active_users, questions, not_found_rate, helpful_rate)`; tỷ lệ `float \| None` khi mẫu số = 0 |
| application | `backend/cwd/application/reporting/get_weekly_stats.py` | `GetWeeklyStats(from_week, to_week)`: validate khoảng ≤ 26 tuần (đề xuất), lấp tuần thiếu bằng hàng 0 |
| application | `backend/cwd/application/reporting/refresh_weekly_stats.py` | `RefreshWeeklyStats`: gọi repository refresh, ghi metric thời gian |
| ports | `backend/cwd/ports/repositories.py` | `StatsRepository.weekly(from_week, to_week) -> list[WeeklyStatsRow]`, `refresh() -> None`, `refreshed_at() -> datetime \| None` |
| adapters | `backend/cwd/adapters/postgres/stats_repository.py` | SQL đọc MV; `REFRESH MATERIALIZED VIEW CONCURRENTLY ops.weekly_stats` |
| entrypoints | `backend/cwd/entrypoints/api/routers/stats.py` | `GET /api/v1/stats/weekly`, dependency `require_role("manager")` |
| entrypoints | `backend/cwd/entrypoints/worker/tasks/maintenance.py` | `@app.task refresh_weekly_stats` (queue `maintenance`, `soft_time_limit=300`) |
| entrypoints | `backend/cwd/entrypoints/worker/beat_schedule.py` | `"refresh-weekly-stats": crontab(minute=5)` (phút thứ 5 mỗi giờ, đề xuất) |
| migrations | `backend/migrations/versions/xxxx_weekly_stats.py` | Tạo bảng, MV, index, quyền |

### 4.2 Mẫu số "tổng người được cấp quyền" (đề xuất)

`access.users` chỉ chứa người **đã đăng nhập ít nhất một lần**, nên không phải tổng người được cấp quyền (BRU-003). Đề xuất bảng nhỏ do PO/IT cập nhật khi danh sách nhóm IdP thay đổi:

```sql
CREATE TABLE ops.authorized_headcount (
  effective_from date PRIMARY KEY,
  headcount      integer NOT NULL CHECK (headcount > 0),
  source         text    NOT NULL,          -- ví dụ "IdP group cwd-users, xuất 15/02/2027"
  updated_by     text    NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
```

Mỗi tuần lấy bản ghi có `effective_from` lớn nhất ≤ ngày cuối tuần; nếu chưa có bản ghi → dự phòng bằng số `access.users` có vai trò `user` tạo trước cuối tuần (ghi chú trong response không có, FE hiển thị như bình thường). Cập nhật bằng lệnh `uv run python -m cwd.entrypoints.cli set-headcount --from 2027-02-22 --count 20 --source "..."` (đề xuất). Câu hỏi mở OQ-160.

### 4.3 Materialized view

Múi giờ tính tuần: `Asia/Ho_Chi_Minh` (đề xuất — tuần làm việc của đội BD, khớp chú thích "thứ Hai – Chủ nhật" trên prototype).

```sql
CREATE MATERIALIZED VIEW ops.weekly_stats AS
WITH ev AS (
  SELECT name, user_id, props, ts,
         to_char(ts AT TIME ZONE 'Asia/Ho_Chi_Minh', 'IYYY-"W"IW') AS iso_week
  FROM ops.analytics_events
  WHERE name IN ('question_submitted','answer_completed','answer_rated')
    AND ts >= now() - interval '13 months'
),
q AS (
  SELECT iso_week, count(*) AS questions, count(DISTINCT user_id) AS active_users
  FROM ev WHERE name = 'question_submitted' GROUP BY iso_week
),
a AS (
  SELECT iso_week, count(*) AS answers,
         count(*) FILTER (WHERE props->>'answer_type' = 'not_found') AS not_found
  FROM ev WHERE name = 'answer_completed' GROUP BY iso_week
),
r_last AS (   -- chỉ lấy đánh giá cuối cùng của mỗi câu trả lời (AC-US021-3 cho phép đổi)
  SELECT DISTINCT ON (props->>'conversation_id', props->>'turn_index')
         iso_week, props->>'rating' AS rating
  FROM ev WHERE name = 'answer_rated'
  ORDER BY props->>'conversation_id', props->>'turn_index', ts DESC
),
r AS (
  SELECT iso_week, count(*) AS rated, count(*) FILTER (WHERE rating = 'up') AS helpful
  FROM r_last GROUP BY iso_week
),
weeks AS (SELECT iso_week FROM q UNION SELECT iso_week FROM a UNION SELECT iso_week FROM r)
SELECT w.iso_week,
       coalesce(q.active_users, 0) AS active_users,
       coalesce(q.questions, 0)    AS questions,
       coalesce(a.answers, 0)      AS answers,
       coalesce(a.not_found, 0)    AS not_found,
       coalesce(r.rated, 0)        AS rated,
       coalesce(r.helpful, 0)      AS helpful,
       now()                       AS refreshed_at
FROM weeks w
LEFT JOIN q USING (iso_week) LEFT JOIN a USING (iso_week) LEFT JOIN r USING (iso_week);

CREATE UNIQUE INDEX weekly_stats_iso_week_uq ON ops.weekly_stats (iso_week);  -- bắt buộc cho CONCURRENTLY
```

- MV lưu **tử số và mẫu số** (không lưu tỷ lệ) để đối chiếu được; tỷ lệ tính ở `GetWeeklyStats` (`None` khi mẫu số 0). `authorized_users` ghép ở tầng ứng dụng từ `ops.authorized_headcount` để PO sửa mà không phải refresh.
- Một đánh giá được tính vào tuần của **lần đánh giá cuối** (đề xuất).
- Loại tài khoản test tải/QA: lọc `user_id NOT IN (SELECT id FROM access.users WHERE 'cwd-test' = ANY(roles))` (đề xuất, cần cho T07-01 chạy trên prod — OQ-161).
- Quyền: role ứng dụng `cwd_app` có `SELECT` trên MV; role `cwd_maintenance` (worker) là owner để refresh.

### 4.4 API

`GET /api/v1/stats/weekly?from=2027-W08&to=2027-W12`

| Trường hợp | Kết quả |
|---|---|
| Thiếu `from`/`to` | Mặc định 8 tuần gần nhất kết thúc ở tuần hiện tại (đề xuất, khớp prototype "8 tuần") |
| Sai định dạng, `from > to`, khoảng > 26 tuần | 400 `VALIDATION_ERROR` (problem+json) |
| Chưa đăng nhập / phiên hết hạn | 401 `UNAUTHENTICATED` / `SESSION_EXPIRED` |
| Không có vai trò `manager` | 403 `FORBIDDEN` (AC-US019-3, phía API) |
| Thành công | 200, mảng theo thứ tự tuần tăng dần, **có đủ mọi tuần** trong khoảng (tuần không có dữ liệu = 0, tỷ lệ `null`) |

```json
[
  {"iso_week": "2027-W08", "authorized_users": 20, "active_users": 14, "questions": 188,
   "not_found_rate": 0.15, "helpful_rate": 0.68}
]
```

Header bổ sung (đề xuất): `Cache-Control: private, no-store`; `X-Stats-Refreshed-At: <ISO-8601>` để FE ghi "Cập nhật lúc …". Không trả bất kỳ nội dung câu hỏi, `user_id` hay tên người dùng (AC-US018-3, PR-06).

## 5. Các bước thực hiện

- [ ] Viết `IsoWeek` + unit test (tuần 53 năm 2026, ranh giới năm 2026-W53 → 2027-W01).
- [ ] Migration: `ops.authorized_headcount`, MV, unique index, GRANT; downgrade xoá MV.
- [ ] `StatsRepository` adapter + integration test với dữ liệu sự kiện seed.
- [ ] `GetWeeklyStats` (lấp tuần trống, tính tỷ lệ, ghép headcount).
- [ ] Router `stats` + `require_role("manager")`; thêm route vào danh sách sinh ma trận phân quyền.
- [ ] Task `refresh_weekly_stats` + beat schedule; khoá Valkey `lock:refresh_weekly_stats` (TTL 10 phút) tránh chạy chồng.
- [ ] Lệnh CLI `set-headcount`.
- [ ] Script `backend/scripts/reconcile_weekly_stats.py --week 2027-W08`: đếm trực tiếp từ `ops.analytics_events`, in bảng so sánh với MV, exit ≠ 0 nếu lệch.
- [ ] Cập nhật mock MSW `frontend/src/lib/api/mocks/stats.ts` theo hợp đồng (phối hợp T06-02).
- [ ] Cập nhật tài liệu API (OpenAPI tự sinh) và runbook "Cập nhật số người được cấp quyền".

## 6. Tiêu chí hoàn thành

- [ ] **AC-US019-2:** với dữ liệu seed ≥ 3 tuần (gồm sự kiện ở 23:59 Chủ nhật và 00:01 thứ Hai giờ VN), `active_users` của mỗi tuần bằng `count(DISTINCT user_id)` của EV-08 đếm trực tiếp; script đối chiếu chạy trên staging cho một tuần bất kỳ báo khớp.
- [ ] **AC-US020-2:** `questions` của mỗi tuần bằng số EV-08 của tuần đó (cùng test và script trên).
- [ ] `not_found_rate`, `helpful_rate` khớp định nghĩa PRD §6.2; đổi đánh giá 👍 → 👎 trên cùng câu trả lời chỉ tính một lần.
- [ ] Người không có vai trò `manager` nhận 403 (test phân quyền tự động; đóng góp cho AC-US019-3 do T06-02 nghiệm thu).
- [ ] MV được refresh mỗi giờ trên staging (kiểm tra `refreshed_at`), refresh không khoá đọc (CONCURRENTLY).
- [ ] p95 thời gian phản hồi endpoint ≤ 300 ms với 13 tháng dữ liệu giả lập 9k câu hỏi/tháng (đề xuất; phục vụ UF-07 "≤ 2 s").

## 7. Kiểm thử

| Tầng | Ca kiểm thử |
|---|---|
| Unit | `IsoWeek` parse/format/range; `GetWeeklyStats` lấp tuần trống, mẫu số 0 → `null`, khoảng > 26 tuần → lỗi |
| Integration | Seed sự kiện → refresh → đọc; ranh giới múi giờ; DISTINCT ON đánh giá; tài khoản `cwd-test` bị loại; refresh song song với đọc |
| Hợp đồng | Schema response khớp SAD §10.2; FE mock dùng cùng JSON schema |
| Phân quyền | anonymous 401, `user` 403, `lead` 403, `manager` 200 |
| Hiệu năng | 1,2 triệu sự kiện giả (13 tháng) → refresh ≤ 60 s, đọc ≤ 300 ms |

## 8. Analytics / observability

- Task không phát sự kiện sản phẩm (EV-19 do FE phát).
- Metric: `cwd_stats_refresh_seconds` (histogram), `cwd_stats_refresh_failures_total`; log `stats.refreshed` với `duration_ms`, `rows`.
- Cảnh báo đề xuất (bổ sung vào [T06-04](T06-04-metrics-dashboards-alerts.md)): `time() - cwd_stats_last_refresh_timestamp > 3h` → Warning.

## 9. Tham chiếu

- USER_STORIES US-019, US-020; PRD §2.2 KR3.1/KR3.2, §6.1 LG-08, §6.2 phễu và chỉ số phái sinh.
- SAD §4.2 (module `reporting`, tác vụ C-03), §4.4, §7.2, §7.4, §10.1, §10.2, ADR-013.
- IMPLEMENTATION_PLAN §4 S6 WP-60.

## 10. Giả định và câu hỏi mở

- Giả định: EV-08/EV-09 được ghi phía server ([T02-05](T02-05-ask-question-sse.md)) nên không phụ thuộc trình duyệt chặn sự kiện; EV-17 ghi phía server ([T06-03](T06-03-answer-feedback.md), đề xuất).
- Giả định: props EV-17 không có `message_id` (PRD §6.2), nên khoá đánh giá duy nhất là (`conversation_id`, `turn_index`).
- **OQ-160 (mới):** Nguồn chính thức của "tổng người được cấp quyền" mỗi tuần — bảng `ops.authorized_headcount` do PO cập nhật hay đồng bộ từ IdP (SCIM/Graph)? Owner: Business owner + IT. Cần trước 15/02/2027.
- **OQ-161 (mới):** Có loại tài khoản test (vai trò/nhóm `cwd-test`) khỏi thống kê không, nhất là khi test tải chạy trên prod? Owner: PO.
- **OQ-162 (mới):** Múi giờ tính tuần ISO: `Asia/Ho_Chi_Minh` (đề xuất) hay UTC? Owner: PO.
