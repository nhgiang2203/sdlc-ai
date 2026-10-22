# T07-01 — Test tải và báo cáo hiệu năng

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — thực hiện tuần 01/02 – 03/02 (trước Tết ~04–10/02) |
| Story / WP | LG-03 (NFR-001, NFR-005, NFR-006); quyết định GPU rerank (RSK-009) |
| Loại | QA, DevOps |
| Ước lượng | 3 ngày công |
| Phụ thuộc | [T05-08](T05-08-prod-provisioning.md) (môi trường prod); thực tế cần [T06-04](T06-04-metrics-dashboards-alerts.md) (metric/dashboard để đo tài nguyên), [T03-01](T03-01-golden-set-v1-scoring.md) (câu hỏi golden set), OQ-031 (tier Claude API, hạn 01/02/2027) |
| Chặn | [T07-06](T07-06-gate-review.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Chứng minh bằng số đo rằng hệ thống đạt NFR-001 (ký tự đầu p90 ≤ 3 s, hoàn chỉnh p90 ≤ 15 s), NFR-005 (PDF ≤ 50 trang p90 ≤ 3 phút; ≤ 500 trang p90 ≤ 15 phút) và NFR-006 (≥ 20 người đồng thời, kho ≥ 500 tài liệu) trên hạ tầng prod; xác định nút cổ chai, ra quyết định bật GPU L4 cho rerank nếu p90 rerank > 0,8 s; xuất **báo cáo test hiệu năng** làm bằng chứng LG-03 cho Trưởng nhóm Dev ký.

## 2. Bối cảnh

- PRD §4.7 NFR-001/005/006, §6.1 LG-03; SAD §12 "Phải xác nhận bằng test tải (LG-03) trước khi chốt", §12.1 phân bổ tài nguyên, §11.2 semaphore 15 lời gọi Claude, rate limit 10 câu/phút & 60 câu/giờ/người; RSK-009, RSK-011; IR-08.
- Đo sơ bộ đã có ở S2, S5 (IMPLEMENTATION_PLAN §6). Đây là lần đo chính thức.
- **Môi trường (đề xuất):** chạy trên **prod trước khi mở cho người dùng** (đúng cấu hình VM-APP/VM-MODEL/VM-DATA SAD §12.1; staging chỉ một VM nên không đại diện), dùng dữ liệu tổng hợp, dọn sạch sau test. Nếu Bảo mật không cho phép dữ liệu test trên prod → chạy trên staging nâng cấu hình tương đương và ghi rõ trong báo cáo (OQ-173).

## 3. Phạm vi

**Trong phạm vi:** kịch bản Locust (`perf/`), seed kho 500 tài liệu, 20 tài khoản test, 5 hồ sơ tải, thu số đo client + server, phân tích, quyết định GPU, báo cáo, dọn dữ liệu.

**Ngoài phạm vi:** tối ưu hiệu năng (lỗi tìm ra → ticket, sửa trong buffer S7); test chaos (EN-06 đã làm S5); test tải trang tĩnh/SPA (Nginx phục vụ asset, rủi ro thấp); kiểm thử bảo mật → [T07-03](T07-03-security-testing.md).

## 4. Thiết kế chi tiết

### 4.1 Công cụ và cấu trúc

Locust 2.x (Python, đọc SSE bằng `requests` stream để đo **ký tự đầu thực tế** = sự kiện `delta` đầu tiên; k6 cần extension cho SSE). Cấu trúc:

```text
perf/
├── locustfile_qa.py          # hỏi đáp SSE
├── locustfile_ingest.py      # tải lên + polling trạng thái
├── common/auth.py            # lấy cookie phiên + CSRF cho tài khoản test
├── common/sse.py             # parse event meta/delta/citation/done/error, đo mốc thời gian
├── data/questions.yaml       # 120 câu: golden set v1 (trừ nhóm khuyến nghị) + biến thể
├── data/corpus_manifest.csv  # 500 tài liệu seed: tên, số trang, nhóm kích thước
├── seed/seed_corpus.py       # tải 500 PDF qua API, chờ READY
├── seed/cleanup.py           # gỡ tài liệu, xoá hội thoại/analytics của tài khoản test
└── report/analyze.py         # gộp CSV Locust + Prometheus → bảng p50/p90/p99, biểu đồ
```

Đăng nhập: 20 tài khoản IdP test `cwd-loadtest-01..20` thuộc nhóm `cwd-users` + `cwd-test` (OQ-161); `auth.py` chạy luồng OIDC thật một lần cho mỗi tài khoản (Authorization Code qua form IdP test, hoặc Keycloak nếu IdP cho phép — OQ-173) rồi tái dùng cookie trong 8 giờ.

### 4.2 Dữ liệu

| Nhóm | Số tài liệu | Trang | Nguồn |
|---|---|---|---|
| Nhỏ | 300 | 5–50 | Bộ PDF mẫu DEP-002 nhân bản có biến đổi tên/số liệu (giữ lớp văn bản) |
| Vừa | 180 | 51–200 | Như trên |
| Lớn | 20 | 201–500 | Như trên |
| **Tổng** | **500** (≥ 500 theo NFR-006) | ~50.000 trang | Không dùng tài liệu thật khi OQ-005 chưa cho phép |

Seed trước ngày test (chạy qua đêm 31/01), ghi lại thời gian xử lý của từng tài liệu làm mẫu NFR-005 khi **không tải**.

### 4.3 Hồ sơ tải

| ID | Hồ sơ | Người dùng | Hành vi | Thời lượng | Mục đích |
|---|---|---|---|---|---|
| P0 | Baseline | 1 | Hỏi tuần tự 30 câu | ~10 phút | Mốc so sánh không tải |
| P1 | **Ổn định (NFR-006)** | 20 đồng thời, tăng 2 người/10 s | Mỗi người: hỏi → đọc 20–60 s → 40% hỏi tiếp (turn > 0) → 15% mở trang PDF (`/file` Range) | 30 phút | NFR-001 dưới tải |
| P2 | Đỉnh | 20 | Gửi gần như cùng lúc (think time 0–5 s), giữ dưới 10 câu/phút/người | 10 phút | Semaphore 15, hàng đợi, 429 |
| P3 | Hỗn hợp nạp + hỏi | 20 hỏi (như P1) + 3 người tải 10 PDF ≤ 50 trang + 2 PDF 500 trang | Đồng thời | 30 phút | NFR-005 dưới tải, tranh chấp TEI embed vs rerank |
| P4 | Bền (đề xuất) | 10 | Như P1 | 2 giờ | Rò rỉ bộ nhớ, kết nối PG, Valkey |

Chạy P1–P3 **hai lần**: (a) Claude thật (key prod, hạn mức theo OQ-031); (b) `FakeLLMAdapter` với độ trễ mô phỏng từ spike (ký tự đầu 1,5 s, 40 token/s) để tách phần truy xuất/hạ tầng khỏi phần LLM. Chi phí ước tính lượt (a): ~1.500 câu × $0,04 ≈ $60 (SAD §12.4) — PO duyệt.

### 4.4 Số đo và ngưỡng đạt

| Chỉ số | Nguồn đo | Ngưỡng đạt (đề xuất theo PRD) |
|---|---|---|
| Ký tự đầu (gửi → `delta` đầu) | Locust client + `cwd_llm_first_token_seconds` | p90 ≤ 3 s ở P1 |
| Hoàn chỉnh (gửi → `done`) | Locust client + `cwd_answer_total_seconds` | p90 ≤ 15 s ở P1 |
| Tỷ lệ lỗi (`error` SSE, 5xx) | Locust | < 1% ở P1 (đề xuất); 429 ở P2 phải có `Retry-After` |
| Rerank | `cwd_retrieval_seconds{stage="rerank"}` | p90 ≤ 0,8 s — vượt → khuyến nghị GPU L4 |
| Truy xuất tổng (embed→rerank) | `cwd_retrieval_seconds` | p90 ≤ 1,5 s (đề xuất) |
| Xử lý PDF ≤ 50 trang | `cwd_ingest_seconds` + EV-05 `processing_seconds` | p90 ≤ 3 phút ở P3 |
| Xử lý PDF ≤ 500 trang | như trên | p90 ≤ 15 phút ở P3 |
| Mở trang PDF (Range) | Locust | p90 ≤ 2 s (UF-03, đề xuất) |
| Tài nguyên | node/postgres exporter | CPU VM-APP, VM-MODEL < 80% trung bình; không OOM; PG kết nối < 80% |
| Ổn định | P4 | RSS API/Worker tăng < 10% sau 2 giờ |

Đo theo **cả lượt đầu và lượt hỏi tiếp** (RSK-008, IR-03) — báo cáo tách riêng.

## 5. Các bước thực hiện

- [ ] (Trước 29/01) PO xác nhận OQ-031, ngân sách chi phí test; IT tạo 20 tài khoản test; Bảo mật đồng ý chạy trên prod (OQ-173).
- [ ] Viết `perf/` + chạy thử 2 người trên staging.
- [ ] 31/01: seed 500 tài liệu trên môi trường test, kiểm `READY` 100% (tài liệu lỗi phải là lỗi có chủ đích).
- [ ] 01/02: P0, P1(a), P1(b); xem dashboard trực tiếp.
- [ ] 02/02: P2, P3(a/b); P4 chạy chiều.
- [ ] 03/02: phân tích, quyết định GPU (họp 30 phút Tech lead + DevOps), viết báo cáo; chạy lại hồ sơ trượt nếu có sửa cấu hình nhanh (ví dụ `hnsw.ef_search`, concurrency worker).
- [ ] Dọn dữ liệu: `cleanup.py` gỡ 500 tài liệu, xoá hội thoại + sự kiện của tài khoản test; xác nhận `ops.weekly_stats` không chứa tài khoản test; khoá 20 tài khoản.
- [ ] Lưu bằng chứng vào `docs/evidence/LG-03/`.

## 6. Tiêu chí hoàn thành

- [ ] **LG-03 / NFR-001:** p90 ký tự đầu ≤ 3 s và hoàn chỉnh ≤ 15 s đo trên kho ≥ 200 tài liệu (ở đây 500) dưới P1.
- [ ] **LG-03 / NFR-005:** p90 xử lý PDF ≤ 50 trang ≤ 3 phút, ≤ 500 trang ≤ 15 phút dưới P3.
- [ ] **LG-03 / NFR-006:** 20 người đồng thời + 500 tài liệu mà vẫn đạt NFR-001.
- [ ] Quyết định GPU rerank được ghi trong báo cáo kèm số đo (RSK-009).
- [ ] Báo cáo được Trưởng nhóm Dev ký; mọi chỉ số trượt có ticket + kế hoạch hoặc được sponsor chấp thuận ngưỡng (OQ-009/OQ-027).
- [ ] Dữ liệu test đã dọn; số liệu thống kê pilot không bị nhiễm.

## 7. Kiểm thử

Mẫu **báo cáo test hiệu năng** (`docs/evidence/LG-03/performance-report.md`):

1. Phiên bản (`git-sha`, `prompt_version`, model, effort), môi trường, cấu hình VM, ngày giờ.
2. Dữ liệu: số tài liệu theo nhóm, tổng đoạn, kích thước chỉ mục.
3. Bảng kết quả từng hồ sơ: p50/p90/p99, tỷ lệ lỗi, số request, 429 — tách lượt đầu/hỏi tiếp, Claude thật/Fake.
4. Biểu đồ: phân bố ký tự đầu, thời gian theo số người dùng, CPU/RAM theo thời gian.
5. Đối chiếu ngưỡng: Đạt / Không đạt từng NFR.
6. Nút cổ chai, khuyến nghị (GPU, concurrency, tham số), rủi ro còn lại.
7. Phụ lục: lệnh chạy, file CSV, ảnh chụp dashboard, link trace mẫu p99.

## 8. Analytics / observability

- Dùng dashboard [T06-04](T06-04-metrics-dashboards-alerts.md); bật annotation Grafana "load test P1 start/end".
- Tạm tắt định tuyến cảnh báo tới kênh trực trong giờ test (silence có thời hạn) để tránh báo động giả; ghi nhận cảnh báo nào đã bắn — dữ liệu hữu ích cho ngưỡng.
- Sự kiện EV-xx của tài khoản test bị loại khỏi thống kê (T06-01).

## 9. Tham chiếu

- PRD §4.7, §6.1 LG-03; USER_STORIES EN-01 (số đo spike); IMPLEMENTATION_PLAN §4 S7, §5.1 (OQ-031), §6, §8 IR-03, IR-08.
- SAD §4.2 (ngân sách thời gian từng bước), §10.3, §11.2, §11.3, §12, RSK-008, RSK-009, RSK-011.

## 10. Giả định và câu hỏi mở

- Giả định: 20 người "đồng thời" = 20 phiên hoạt động hỏi liên tục với think time 20–60 s (hành vi thực tế), không phải 20 request cùng mili giây — hồ sơ P2 bao phủ trường hợp đỉnh.
- Giả định: rate limit theo người không bị nới cho tài khoản test (đo đúng hành vi prod).
- **OQ-173 (mới):** Có được chạy test tải với dữ liệu tổng hợp và tài khoản test trên prod trước go-live không? Cách đăng nhập tự động cho tài khoản test với IdP thật? Owner: Bảo mật thông tin + IT. Cần trước 29/01/2027.
- OQ-031 (kế thừa): tier/giới hạn tốc độ Claude API — nếu thấp hơn 15 lời gọi đồng thời, hồ sơ P2 sẽ đo hành vi "thông báo bận".
- OQ-009, OQ-027 (kế thừa): ngưỡng NFR-001/005/006 là "(đề xuất)".
