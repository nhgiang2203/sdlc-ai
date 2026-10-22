# T06-08 — Bảo vệ ngân sách LLM: giảm hạn mức khi chạm 100%

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S6 (18/01 – 29/01/2027) |
| Story / WP | SAD §11.2 "Bảo vệ chi phí", RSK-006, LG-09 |
| Loại | BE |
| Ước lượng | 1,5 ngày công |
| Phụ thuộc | [T01-02](T01-02-csrf-rbac-ratelimit-me.md) (rate limiter), [T02-05](T02-05-ask-question-sse.md), [T06-04](T06-04-metrics-dashboards-alerts.md) (metric chi phí, cấu hình ngân sách) |
| Chặn | [T07-06](T07-06-gate-review.md) (bằng chứng LG-09) |
| Trạng thái | Todo |

## 1. Mục tiêu

Khi chi phí Claude ước tính từ đầu tháng tới hiện tại chạm **100%** ngân sách tháng, hệ thống tự giảm hạn mức câu hỏi của mỗi người dùng. Như vậy chi phí không vượt kiểm soát trong pilot, còn người dùng vẫn hỏi được ở mức tối thiểu. Ngưỡng 80% chỉ cảnh báo và đã làm ở T06-04 (cảnh báo A6).

## 2. Bối cảnh

- SAD §11.2: "Ngưỡng chi phí tháng (ước tính từ `usage`); chạm 80% → cảnh báo; chạm 100% → giảm hạn mức câu hỏi/người (RSK-006)".
- T06-04 đã có `cwd_llm_cost_usd_total{purpose}`, `cwd_llm_monthly_budget_usd`, `config/llm_pricing.yaml` và cấu hình `LLM_MONTHLY_BUDGET_USD` (đề xuất 500 USD, chờ OQ-011). T06-04 ghi rõ phần tự giảm hạn mức là ngoài phạm vi (OQ-166).
- Metric Prometheus là bộ đếm theo tiến trình và có thể bị reset. Vì vậy **quyết định chặn không đọc từ Prometheus** mà từ nguồn bền vững: `conv.messages.usage` trong PostgreSQL.
- Rate limit hiện tại (T01-02): 10 câu/phút và 60 câu/giờ mỗi người, token bucket trong Valkey, policy cấu hình được.

## 3. Phạm vi

**Trong phạm vi:**
- Tính chi phí tháng hiện tại từ `conv.messages.usage`, cache trong Valkey.
- Chuyển chế độ `normal` ↔ `reduced` theo ngưỡng.
- Áp policy rate limit giảm khi ở `reduced`.
- Thông báo cho người dùng khi bị chặn, metric, log, tài liệu vận hành.

**Ngoài phạm vi:**
- Cảnh báo 80% và dashboard chi phí: [T06-04](T06-04-metrics-dashboards-alerts.md).
- Chặn hẳn dịch vụ: không làm, vì chặn hẳn trái mục tiêu pilot.
- Ngân sách theo phòng ban hay theo người: chưa có yêu cầu.

## 4. Thiết kế chi tiết

**Module**

| File | Nội dung |
|---|---|
| `backend/cwd/application/qa/budget_guard.py` | `BudgetGuard.current_mode() -> BudgetMode` (`NORMAL` / `REDUCED`), `BudgetGuard.refresh()` |
| `backend/cwd/ports/cost_ledger.py` | `CostLedgerPort.month_to_date_usd(now) -> Decimal` |
| `backend/cwd/adapters/postgres/cost_ledger.py` | Truy vấn SQL bên dưới; dùng lại hàm tính tiền từ `config/llm_pricing.yaml` (T06-04) |
| `backend/cwd/entrypoints/worker/tasks/budget.py` | Task `refresh_budget_mode` chạy 5 phút/lần (Celery beat, hàng đợi `maintenance`) |

**Tính chi phí tháng** (`usage` lưu theo T02-05; bước viết lại câu hỏi ghi `usage` riêng theo T05-01):

```sql
SELECT model,
       sum((usage->>'input_tokens')::bigint)                 AS input,
       sum((usage->>'output_tokens')::bigint)                AS output,
       sum(coalesce((usage->>'cache_read_input_tokens')::bigint, 0))     AS cache_read,
       sum(coalesce((usage->>'cache_creation_input_tokens')::bigint, 0)) AS cache_write
FROM conv.messages
WHERE role = 'assistant' AND created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')
GROUP BY model;
```

Kết quả nhân với bảng giá theo model. Tháng tính theo giờ Việt Nam (đề xuất). Nếu `usage` của bước viết lại câu hỏi nằm trong một khoá con (ví dụ `usage.rewrite`), cộng thêm khoá đó; chốt theo cấu trúc thực tế của T05-01.

**Chế độ và chuyển trạng thái**

| Điều kiện | Chế độ | Policy câu hỏi |
|---|---|---|
| Chi phí < 100% `LLM_MONTHLY_BUDGET_USD` | `NORMAL` | 10/phút, 60/giờ (T01-02) |
| Chi phí ≥ 100% | `REDUCED` | `BUDGET_REDUCED_PER_HOUR` = 10/giờ, `BUDGET_REDUCED_PER_DAY` = 30/ngày (đề xuất, PO chốt) |
| Sang tháng mới, hoặc PO tăng ngân sách | Về `NORMAL` | Tự động ở lần refresh kế tiếp |

- `refresh_budget_mode` ghi `budget:mode` và `budget:mtd_usd` vào Valkey (TTL 15 phút). Nếu khoá hết hạn hoặc Valkey lỗi thì coi là `NORMAL` (fail-open, nhất quán với OQ-104) và ghi log `warning`.
- `AskQuestion` (T02-05) đọc `BudgetGuard.current_mode()` ở bước 1. Nếu là `REDUCED` thì áp thêm policy `question_budget_reduced` qua `rate_limit(policy)` của T01-02. Policy thường vẫn được áp.
- Ghi đè khẩn cấp: biến `BUDGET_GUARD_ENABLED=false` tắt cơ chế mà không cần deploy lại code (chỉ cần restart container).

**Phản hồi khi bị chặn ở chế độ `REDUCED`:** 429 `RATE_LIMITED` kèm `Retry-After`, problem `detail` "Hệ thống đang giới hạn số câu hỏi do đã dùng hết hạn mức tháng. Bạn có thể hỏi tiếp sau X phút." và extension `reason: "budget"`. FE dùng lại cách hiển thị 429 của T02-06: giữ câu hỏi trong ô soạn, hiện thông báo theo `detail`.

## 5. Các bước thực hiện

- [ ] Port + adapter `CostLedger`, unit test tính tiền với `usage` mẫu (dùng chung fixture của T06-04).
- [ ] `BudgetGuard` + task `refresh_budget_mode` + lịch beat.
- [ ] Thêm policy `question_budget_reduced` vào cấu hình rate limit; nối vào `AskQuestion`.
- [ ] Thêm `reason` vào problem 429; FE kiểm tra lại thông báo (không cần component mới).
- [ ] Metric và log (§8); thêm panel "Chế độ ngân sách" vào dashboard LLM của T06-04.
- [ ] Ghi quy trình vào runbook (T07-02): tăng ngân sách, tắt guard, kiểm tra chế độ hiện tại.

## 6. Tiêu chí hoàn thành

- [ ] Khi chi phí từ đầu tháng ≥ ngân sách, sau ≤ 5 phút chế độ chuyển sang `REDUCED` và người dùng bị giới hạn theo policy giảm.
- [ ] Người dùng bị chặn thấy thông báo nêu lý do hạn mức tháng; câu hỏi không bị mất.
- [ ] Đổi `LLM_MONTHLY_BUDGET_USD` lên cao hơn chi phí hiện tại thì chế độ về `NORMAL` ở lần refresh kế tiếp.
- [ ] Valkey lỗi hoặc thiếu khoá thì không chặn người dùng, có log `warning`.
- [ ] LG-09: biên bản ghi ngưỡng chi phí tháng, ngưỡng 80% (T06-04) và hành vi ở 100% (task này).

## 7. Kiểm thử

| Loại | Kịch bản |
|---|---|
| Unit | Tính tiền theo model, có và không có cache; ranh giới tháng theo giờ Việt Nam (23:59 ngày 31 và 00:00 ngày 1) |
| Unit | `BudgetGuard`: dưới, bằng và trên ngưỡng; Valkey lỗi → `NORMAL` |
| Integration | Testcontainers: chèn message có `usage` vượt ngưỡng → chạy task → `AskQuestion` trả 429 `reason=budget` sau khi hết hạn mức giảm |
| Staging | Đặt `LLM_MONTHLY_BUDGET_USD=1` và hỏi vài câu thật: chế độ chuyển `REDUCED`, panel dashboard đổi, sau đó khôi phục ngân sách |

## 8. Analytics / observability

- Metric: gauge `cwd_budget_mode` (0 = normal, 1 = reduced); gauge `cwd_llm_cost_month_to_date_usd` (giá trị từ PostgreSQL, dùng đối chiếu với recording rule của T06-04); counter `cwd_ratelimit_rejections_total{policy="question_budget_reduced"}`.
- Log `info` khi đổi chế độ, gồm chi phí và ngân sách. Không ghi nội dung câu hỏi (PR-06).
- Cảnh báo bổ sung (đề xuất): `cwd_budget_mode == 1` → Warning gửi kênh của đội và PO.
- Analytics sản phẩm: không thêm sự kiện. EV-10 không áp dụng vì câu hỏi bị chặn trước khi gửi.

## 9. Tham chiếu

- SAD §11.2 (bảo vệ chi phí, rate limiting), §12.4 (ước tính chi phí), RSK-006, OQ-011.
- [T06-04](T06-04-metrics-dashboards-alerts.md) (A6, bảng giá), [T01-02](T01-02-csrf-rbac-ratelimit-me.md) (`RateLimiterPort`), [T02-05](T02-05-ask-question-sse.md), [T05-01](T05-01-follow-up-rewrite-history.md) (`usage` của bước viết lại câu hỏi).

## 10. Giả định và câu hỏi mở

- Giả định: `conv.messages.usage` ghi đủ token của mọi lời gọi Claude, kể cả bước viết lại câu hỏi. Golden set chạy bằng tài khoản eval trên staging nên không tính vào ngân sách prod.
- OQ-011 (kế thừa): ngân sách tháng chính thức.
- OQ-166 (từ T06-04): task này là câu trả lời đề xuất. PO xác nhận mức policy giảm (10/giờ, 30/ngày) hoặc chọn chỉ cảnh báo.
