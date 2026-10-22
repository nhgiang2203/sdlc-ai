# T05-07 — Circuit breaker và chế độ suy giảm

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S5 (04/01 – 15/01/2027) |
| Story / WP | EN-06 · WP-53 |
| Loại | BE |
| Ước lượng | 2,5 ngày công |
| Phụ thuộc | [T02-02](T02-02-hybrid-retrieval-rerank.md) (`TEIEmbeddingAdapter`, `TEIRerankAdapter`, truy vấn lai), [T02-03](T02-03-claude-llm-adapter.md) (`ClaudeLLMAdapter`); liên quan [T05-01](T05-01-follow-up-rewrite-history.md) (lời gọi viết lại cũng qua `LLMPort`), [T03-02](T03-02-not-found-gate-calibration.md) (cổng τ_nf) |
| Chặn | — (cảnh báo `cwd_circuit_state` ở [T06-04](T06-04-metrics-dashboards-alerts.md) dùng metric của task này) |
| Trạng thái | Todo |

## 1. Mục tiêu

Hệ thống vẫn phục vụ khi một phụ thuộc mềm lỗi: (1) circuit breaker quanh Claude API và model server (TEI) từ chối nhanh khi phụ thuộc đang hỏng; (2) khi TEI lỗi, hỏi đáp chạy ở chế độ `degraded` chỉ dùng toàn văn; (3) khi Claude lỗi, người dùng thấy EC-07 ngay, câu hỏi không mất. Chứng minh bằng test chaos trên staging.

## 2. Bối cảnh

- SAD §6.1: model server và Claude là phụ thuộc **mềm** của API; §8.1 nhánh lỗi (model server lỗi / timeout 2 s → bỏ embedding/rerank, dùng toàn văn + RRF, đánh dấu `degraded`; Claude không có ký tự đầu sau 30 s, 5xx/429 sau retry, circuit mở → `FAILED`, SSE `error service_unavailable`); §9.4 (CLOSED → OPEN → sau 30 s HALF_OPEN → 1 request thử); §11.2 (circuit quanh Claude và model server, "mở sau 5 lỗi / 30 s"; TEI 1 retry sau 200 ms; SDK Claude `max_retries = 2`); §11.3 metric `cwd_retrieval_degraded_total`, `cwd_circuit_state{target}`, cảnh báo "Circuit mở > 2 phút"; §6.2 chọn pybreaker; §11.2 SPOF VM-MODEL ("Hỏi đáp vẫn chạy ở chế độ degraded").
- EN-06 tiêu chí: tắt TEI → hỏi đáp vẫn chạy, metric `degraded` tăng; Claude lỗi 5 lần → circuit mở, người dùng thấy EC-07.
- **Mâu thuẫn nguồn:** §9.4 ghi "5 lỗi liên tiếp trong 60 s"; §11.2 và IMPLEMENTATION_PLAN ghi "5 lỗi / 30 s". Task này dùng: mở sau **5 lỗi liên tiếp**, giữ OPEN **30 s** rồi HALF_OPEN (đề xuất, khớp hành vi pybreaker `fail_max=5`, `reset_timeout=30`); xem OQ-T0507-01.

## 3. Phạm vi

**Trong phạm vi:** breaker `claude`, `tei_embed`, `tei_rerank` cho API; trạng thái dùng chung giữa các replica; phân loại lỗi tính/không tính; fail-fast cho SSE; luồng truy xuất `degraded`; cờ `degraded` trong SSE `done` và banner FE nhỏ; metric; sửa `/readyz`; script chaos; runbook ngắn.

**Ngoài phạm vi:** breaker cho Worker (job ingest đã có retry/backoff, TEI lỗi → job retry — T02-08); object storage (không breaker, 503 ở T04-01); dashboard và rule cảnh báo ([T06-04](T06-04-metrics-dashboards-alerts.md)); semaphore 15 lời gọi Claude (đã có ở T02-05).

## 4. Thiết kế chi tiết

### 4.1 Module

| File | Nội dung |
|---|---|
| `backend/cwd/adapters/resilience/circuit_breaker.py` | `AsyncCircuitBreaker(name, fail_max=5, reset_timeout=30, storage)`; `async with breaker.guard():` ném `CircuitOpenError` khi OPEN; `record_success()`, `record_failure()`; HALF_OPEN chỉ cho 1 request thử (khoá Valkey `SET NX PX`) |
| `backend/cwd/adapters/resilience/valkey_breaker_storage.py` | Trạng thái chung: `cb:{name}:state`, `cb:{name}:fails`, `cb:{name}:opened_at`; Valkey lỗi → rơi về bộ nhớ tiến trình (không chặn request) |
| `backend/cwd/adapters/claude/llm_adapter.py` | Bọc `stream()` và `complete()` bằng breaker `claude` |
| `backend/cwd/adapters/model_server/tei_*_adapter.py` | Bọc `/embed` (timeout 2 s, 1 retry 200 ms), `/rerank` (2 s) bằng breaker riêng |
| `backend/cwd/application/qa/retrieve.py` | Nhánh `degraded` |
| `backend/cwd/entrypoints/api/health.py` | `/readyz` chỉ kiểm tra phụ thuộc cứng |
| `deploy/chaos/` | `tei_down.sh`, `claude_fault.sh`, `README.md` |

**Thư viện:** SAD chọn pybreaker; pybreaker 1.x không có API async thuần (`call_async` dựa Tornado) và không bọc được stream. Đề xuất viết `AsyncCircuitBreaker` ~100 dòng theo đúng máy trạng thái §9.4, giữ pybreaker cho mã đồng bộ (Worker) nếu cần — Tech lead chốt (OQ-T0507-02).

### 4.2 Lỗi được tính

| Đích | Tính là lỗi | Không tính |
|---|---|---|
| `claude` | `APIConnectionError`, `APITimeoutError`, timeout ký tự đầu 30 s, `InternalServerError` (5xx, 529 overloaded), `RateLimitError` **sau** khi SDK đã retry 2 lần (một lời gọi logic = tối đa một lỗi) | `BadRequestError` (lỗi của ta), `stop_reason = "refusal"`, người dùng huỷ (STOPPED), lỗi giữa stream do client ngắt |
| `tei_embed`, `tei_rerank` | Timeout 2 s (sau 1 retry), lỗi kết nối, 5xx | 4xx (đầu vào sai) |

Thành công ở HALF_OPEN → CLOSED, xoá bộ đếm; thất bại → OPEN thêm 30 s. Thành công ở CLOSED xoá bộ đếm (tính "liên tiếp").

### 4.3 Claude lỗi / breaker mở

- Bước 1 `AskQuestion`: nếu `claude` OPEN → vẫn mở SSE, phát `meta` rồi `error {code: "service_unavailable", retryable: true}` ngay, **bỏ qua** truy xuất (tiết kiệm TEI) (đề xuất); lưu message user + assistant `status = FAILED`; EV-10 `error_type = service_unavailable`, `elapsed_ms`.
- Bước 9 gặp `CircuitOpenError` hoặc lỗi tính → như trên.
- Bước 2 (viết lại, T05-01) gặp `CircuitOpenError` → không fallback sang câu gốc mà kết thúc lượt bằng `error` (lời gọi trả lời chắc chắn cũng hỏng).
- FE (T02-06) đã hiển thị EC-07 "Hệ thống đang bận, vui lòng thử lại sau ít phút." + "Thử lại", câu hỏi được giữ.

### 4.4 TEI lỗi → `degraded`

| Lỗi | Bước 3–7 thay bằng |
|---|---|
| `tei_embed` OPEN/lỗi | Bỏ nhánh vector; chỉ CTE `fts` (top 40) |
| `tei_rerank` OPEN/lỗi (embed vẫn tốt) | Giữ vector + fts + RRF; lấy top 8 theo RRF, không rerank |
| Cả hai | Chỉ fts, top 8 theo `ts_rank_cd` |

- Cổng τ_nf dựa trên điểm rerank → không áp dụng khi không có rerank. Thay thế (đề xuất): fts trả 0 dòng (và không có nhánh vector) → `not_found` không gọi LLM; ngược lại gọi LLM và dựa vào câu cố định not_found của system prompt (SAD §9.2).
- Ghi `degraded = true` + `degraded_stages` vào trace (`qa.retrieve`), metric `cwd_retrieval_degraded_total{stage="embed"|"rerank"}`, cột `conv.messages.usage.degraded` trong JSON usage (không cần migration).
- SSE `done` thêm `degraded: bool` (đề xuất, bổ sung SAD §10.3). FE: `Banner tone="warning"` trạng thái `degraded` (Blueprint §3.6.2) "Tìm kiếm đang ở chế độ hạn chế, kết quả có thể kém đầy đủ hơn." hiển thị khi lượt gần nhất `degraded` (đề xuất; thay đổi nhỏ trong `AppShell`, ~0,25 ngày, có thể tắt bằng cờ `FEATURE_DEGRADED_BANNER`).

### 4.5 `/readyz`

SAD §10.2 ghi `/readyz` kiểm tra PG, Valkey, model server → 503. Nginx dùng `/readyz` làm health check upstream (§11.2); nếu TEI hỏng mà `/readyz` = 503 thì Nginx loại **cả hai** replica API, trái với chế độ suy giảm. Đề xuất: `/readyz` chỉ kiểm tra phụ thuộc cứng (PostgreSQL, Valkey); trạng thái TEI/Claude đưa vào body `{"soft": {"tei_embed": "open"|"closed", ...}}` và metric — OQ-T0507-03.

### 4.6 Chaos trên staging

| Kịch bản | Cách làm | Kỳ vọng |
|---|---|---|
| C1 TEI tắt | `deploy/chaos/tei_down.sh`: `docker compose stop tei-embed tei-rerank` trên VM-MODEL staging; gửi 10 câu golden set | 10/10 có kết quả (answered/partial/not_found), `done.degraded = true`, `cwd_retrieval_degraded_total` tăng, `cwd_circuit_state{target="tei_embed"} = 2`, API vẫn trong upstream Nginx |
| C2 TEI phục hồi | `start` lại; chờ 30 s; hỏi | HALF_OPEN → CLOSED; `degraded = false` |
| C3 Claude lỗi | `claude_fault.sh`: đặt `CWD_ANTHROPIC_BASE_URL=http://fault-stub:8089` (container stub trả 529 cho mọi request) trên staging, restart API; gửi 6 câu | 5 câu đầu `error service_unavailable` sau retry; câu thứ 6 `error` trong < 200 ms, `cwd_circuit_state{target="claude"} = 2`; FE hiển thị EC-07 và giữ câu hỏi |
| C4 Claude phục hồi | Trả base URL thật; sau 30 s hỏi | Một request thử thành công → CLOSED |
| C5 Valkey restart khi breaker OPEN | `docker restart valkey` | Breaker rơi về bộ nhớ, không lỗi 500 |

Kết quả ghi vào `deploy/chaos/REPORT-S5.md` (ảnh chụp metric) làm bằng chứng EN-06.

## 5. Các bước thực hiện

- [ ] `AsyncCircuitBreaker` + storage Valkey + unit test máy trạng thái (đồng hồ giả).
- [ ] Bọc adapter Claude (`stream`, `complete`) và TEI; phân loại lỗi.
- [ ] Fail-fast trong `AskQuestion`; nhánh `degraded` trong `retrieve`; thay thế cổng τ_nf khi không rerank.
- [ ] `done.degraded`, usage, metric, trace; banner FE (tuỳ cờ).
- [ ] Sửa `/readyz` (sau khi OQ-T0507-03 được chốt) và health check compose/Nginx.
- [ ] Container `fault-stub` (FastAPI 20 dòng) trong `deploy/compose/staging.yml` profile `chaos`.
- [ ] Chạy C1–C5 trên staging, viết báo cáo; runbook "Claude/TEI lỗi" ngắn trong `docs/runbooks/`.

## 6. Tiêu chí hoàn thành

- [ ] **EN-06 (1):** tắt TEI → hỏi đáp vẫn trả lời, metric `cwd_retrieval_degraded_total` tăng (C1, C2 đạt).
- [ ] **EN-06 (2):** Claude lỗi 5 lần liên tiếp → circuit mở, lời gọi tiếp theo bị từ chối ngay, người dùng thấy EC-07; sau 30 s một request thử, thành công thì đóng (C3, C4 đạt).
- [ ] Trạng thái breaker nhất quán giữa 2 replica API (staging chạy 2 replica cho test này).
- [ ] Lỗi 4xx/refusal/STOPPED không làm tăng bộ đếm lỗi (unit test).
- [ ] TEI hỏng không làm `/readyz` của API trả 503 (sau khi chốt OQ-T0507-03).
- [ ] Golden set ở chế độ bình thường không hồi quy; báo cáo thêm một lần chạy golden set ở chế độ `degraded` để PO biết mức suy giảm (chỉ tham khảo).

## 7. Kiểm thử

| Tầng | Kịch bản |
|---|---|
| Unit | Breaker: 4 lỗi + 1 thành công → vẫn CLOSED; 5 lỗi → OPEN; trong 30 s → `CircuitOpenError`; sau 30 s chỉ 1 request đi qua (2 coroutine đồng thời); HALF_OPEN lỗi → OPEN; phân loại ngoại lệ |
| Integration | `retrieve` với fake TEI ném timeout → chỉ fts, `degraded`; fts rỗng → not_found không gọi LLM; Claude fake 529 × 5 → fail-fast lần 6 |
| Hợp đồng SSE | `done.degraded`; `error` sau `meta` khi breaker mở |
| Chaos (staging) | C1–C5 §4.6 |

## 8. Analytics / observability

- Metric `cwd_circuit_state{target}` (gauge: 0 CLOSED, 1 HALF_OPEN, 2 OPEN — đề xuất mã hoá), `cwd_circuit_transitions_total{target, to}`, `cwd_retrieval_degraded_total{stage}`.
- Log `warning` khi chuyển trạng thái (`target`, `from`, `to`, `fail_count`) — không có nội dung câu hỏi.
- EV-10 `answer_failed` `error_type = service_unavailable` (đã có); EV-09 không đổi (cân nhắc thêm `degraded` sau khi PO duyệt danh mục — OQ-T0507-04).

## 9. Tham chiếu

USER_STORIES §8 EN-06; SAD §6.1, §6.2, §8.1 (nhánh lỗi), §9.4, §10.2, §10.3, §11.2, §11.3; Blueprint §3.6.2 `Banner`; PRD EC-07, EV-10; IMPLEMENTATION_PLAN S5 WP-53, §6 (Chaos).

## 10. Giả định và câu hỏi mở

- Giả định: staging có thể chạy 2 replica API và có VM-MODEL riêng (SAD §13.2 "dùng chung VM-MODEL của staging").
- **OQ-T0507-01:** Ngưỡng mở breaker: "5 lỗi liên tiếp trong 60 s" (§9.4) hay "5 lỗi / 30 s" (§11.2)? Đề xuất 5 lỗi liên tiếp, OPEN 30 s; cập nhật SAD cho thống nhất.
- **OQ-T0507-02:** Dùng pybreaker (đồng bộ) hay `AsyncCircuitBreaker` tự viết / `aiobreaker`? Đề xuất tự viết cho API async.
- **OQ-T0507-03:** `/readyz` có nên loại model server khỏi kiểm tra (để không mâu thuẫn chế độ degraded)? Cần Architect sửa SAD §10.2.
- **OQ-T0507-04:** Có cần banner "chế độ hạn chế" cho người dùng và thuộc tính `degraded` trong EV-09 không? PO quyết.
