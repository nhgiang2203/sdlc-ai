# T07-04 — Hồi quy cuối: golden set có SME, EC-01..EC-23, E2E

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — tuần 11/02 – 15/02 (sau Tết) |
| Story / WP | LG-02, LG-05 (đồng thời tổng hợp báo cáo AC cho LG-01 và kiểm tra sự kiện cho LG-08 — đề xuất) |
| Loại | QA, SME |
| Ước lượng | 3 ngày công (QA 2, SME 1 — ~8 giờ chấm) |
| Phụ thuộc | [T03-01](T03-01-golden-set-v1-scoring.md) (golden set v1, runner, phiếu SME, cổng hồi quy); thực tế cần mọi task tính năng S1–S6 đã `Done` và code freeze (M4) |
| Chặn | [T07-05](T07-05-uat-user-guide.md), [T07-06](T07-06-gate-review.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Trên bản release ứng viên (RC) đóng băng, chạy và lập báo cáo: (1) golden set bản cuối ≥ 100 câu có SME chấm, đạt NFR-002 và đúng phân bố nhóm câu LG-02; (2) toàn bộ test case EC-01..EC-23 đã chạy; (3) E2E hành trình J1 và mọi story P0, coverage unit ≥ 70% `domain` + `application` (LG-05); (4) báo cáo kiểm thử AC cho LG-01; (5) kiểm tra 100% sự kiện P0 trên staging cho LG-08.

## 2. Bối cảnh

- LG-02: NFR-002 (≥ 85% đúng và trích dẫn đúng; ≥ 90% câu không có đáp án → "không tìm thấy"; 0 câu kiến thức chung trả lời ngoài tài liệu) trên golden set ≥ 100 câu với phân bố ≥ 40% một tài liệu, 20% đa tài liệu, 15% không có đáp án, 10% diễn đạt khác, 10% tiếng Anh, 5% yêu cầu khuyến nghị. Người ký: Trưởng nhóm BD (phiếu SME, DEP-003).
- LG-05: E2E cho J1 + mọi story P0; coverage ≥ 70% (đề xuất); EC-01..EC-23 có test case và đã chạy. Người ký: QA lead.
- LG-01 (QA lead ký): 100% AC của 9 story P0; ≥ 90% AC story P1 đạt hoặc được hoãn. IMPLEMENTATION_PLAN §9.2: "S1–S6, tổng hợp S7" — README không giao LG-01 cho task S7 nào, task này nhận phần tổng hợp (đề xuất).
- Golden set đã chạy tự động mỗi lần đổi prompt/model từ S2 (T02-10) và cổng hồi quy > 3 điểm % (T03-01).

## 3. Phạm vi

**Trong phạm vi:** đóng băng RC; chạy golden set chấm tự động + SME chấm 100%; ma trận EC; chạy E2E + axe trên staging; báo cáo coverage; báo cáo AC (LG-01); checklist sự kiện P0 (LG-08); phân loại lỗi Sev cho LG-06; chạy lại sau sửa lỗi.

**Ngoài phạm vi:** test tải → [T07-01](T07-01-load-test.md); bảo mật/phân quyền → [T07-03](T07-03-security-testing.md); UAT với người dùng → [T07-05](T07-05-uat-user-guide.md); sửa lỗi (đội dev, buffer S7).

## 4. Thiết kế chi tiết

### 4.1 Đóng băng và phiên bản

- RC tag `rc-2027.02.11` (đề xuất) deploy staging; ghi `git-sha`, `prompt_version`, model, effort, τ_keep, τ_nf, golden set `eval/golden_set.v1.N.yaml`.
- Sau đó chỉ merge sửa lỗi có ticket; mỗi lần sửa chạm pipeline hỏi đáp → chạy lại golden set tự động; SME chấm lại **chỉ các câu thay đổi kết quả** (đề xuất).

### 4.2 Golden set bản cuối

| Bước | Chi tiết |
|---|---|
| Kiểm tra phân bố | Script `eval/check_distribution.py` in số câu từng nhóm (`single_doc`, `multi_doc`, `no_answer`, `paraphrase`, `english`, `recommendation`) và so ngưỡng LG-02; thiếu → SME bổ sung trước 11/02 |
| Chạy | `uv run python -m eval.run --env staging --set eval/golden_set.v1.N.yaml --runs 2` (2 lần để thấy dao động) |
| Chấm tự động | Theo T03-01: đúng not_found, có ≥ 1 trích dẫn, trang trích dẫn ∈ trang đáp án, khớp từ khoá đáp án |
| Chấm SME | Phiếu chấm từng câu: **Đúng nội dung** (Đúng / Một phần / Sai), **Trích dẫn đúng** (Có / Không), **Có thông tin ngoài tài liệu** (Có / Không), **Có đưa khuyến nghị** (Có / Không), ghi chú. 2 SME chấm chéo 20% câu để đo đồng thuận (đề xuất) |
| Tính chỉ số | `answered_correct_rate` = câu có đáp án được chấm Đúng + trích dẫn đúng ÷ câu có đáp án; `not_found_rate` trên nhóm `no_answer`; số câu kiến thức chung trả lời ngoài tài liệu; nhóm `recommendation`: 100% không đưa khuyến nghị (EC-15) |
| Báo cáo | `eval/reports/final-<ngày>.md` + so với lần chạy M3 và lần gần nhất; phân tích lỗi theo nhóm (bảng, tiếng Anh…) |

### 4.3 Ma trận EC-01..EC-23

`docs/evidence/LG-05/ec-matrix.md` — mỗi EC một hàng: ID, tình huống (PRD §5.2), story, task triển khai, loại test (E2E tự động / thủ công), file test Playwright, môi trường, kết quả, ticket lỗi.

| EC | Cách kiểm (đề xuất) |
|---|---|
| EC-01, EC-02, EC-03, EC-18 | E2E: kho trống, chỉ tài liệu đang xử lý, một phần đang xử lý, phạm vi chỉ gồm tài liệu lỗi |
| EC-04, EC-05, EC-06 | E2E `context.setOffline(true)` giữa upload / giữa stream / khi soạn |
| EC-07 | E2E với `FakeLLMAdapter` không trả ký tự đầu 30 s; staging: chặn egress tạm |
| EC-08..EC-11 | E2E với bộ file lỗi QA (không phải PDF, > 50 MB, mật khẩu, hỏng, scan, scan một phần, trùng) |
| EC-12, EC-13 | Component + E2E: rỗng, khoảng trắng, 1.999/2.000/2.001 ký tự |
| EC-14, EC-15 | Golden set nhóm `no_answer`/`recommendation` + E2E câu chào |
| EC-16, EC-17, EC-22 | E2E 2 trình duyệt: gỡ trong lúc trả lời; hội thoại cũ trích dẫn tài liệu đã gỡ; hai người cùng gỡ |
| EC-19, EC-20, EC-21 | E2E: phiên hết hạn giữ bản nháp; NOGRP; mở link hội thoại người khác |
| EC-23 | E2E: chặn `/file` trả 500 → "Không tải được tài liệu" + "Thử lại" |

### 4.4 E2E và coverage

- Suite Playwright `e2e/` chạy trên staging với Claude thật (J1 + P0) và trên CI với `FakeLLMAdapter` (toàn bộ). Báo cáo HTML + video lỗi.
- Danh sách bắt buộc: J1 (UF-01) đầu-cuối; US-001, US-002, US-003, US-004, US-008..US-012 mỗi AC ≥ 1 test; axe-core trên workspace, audit, stats, history (NFR-008).
- Coverage: `pytest --cov=cwd.domain --cov=cwd.application --cov-fail-under=70`; Vitest coverage cho `features/*` báo cáo tham khảo.
- Trình duyệt: Chrome + Edge 2 phiên bản mới nhất, 1280 px và 768 px (NFR-007) — thủ công 1 lượt J1 mỗi tổ hợp.

### 4.5 Báo cáo AC (LG-01) và sự kiện (LG-08)

- `docs/evidence/LG-01/ac-report.md`: mọi AC-USxxx-n → test (file/case) → kết quả RC → ghi chú hoãn (nếu P1 hoãn, kèm chữ ký sponsor). Tính % P0 (phải 100%) và % P1 (≥ 90%).
- `docs/evidence/LG-08/event-check.md`: với mỗi sự kiện P0 (EV-01..EV-06, EV-08, EV-09, EV-10, EV-12, EV-17): thao tác kích hoạt, truy vấn kiểm `ops.analytics_events` trên staging (`name`, props đúng schema, không có nội dung), kết quả. Thêm kiểm tra trang Thống kê khớp script đối chiếu (T06-01).

## 5. Các bước thực hiện

- [ ] 29/01 (M4): xác nhận code freeze, lập danh sách ticket mở.
- [ ] Trước Tết: hoàn thiện ma trận EC, đặt lịch SME 11–12/02 (DEP-003).
- [ ] 11/02: deploy RC, chạy golden set 2 lần, suite E2E staging + CI, coverage.
- [ ] 11–12/02: SME chấm phiếu; QA tổng hợp.
- [ ] 12/02: chạy EC thủ công còn lại; checklist sự kiện P0.
- [ ] 13–15/02: triage lỗi (Sev-1..Sev-4), sửa, chạy lại phần liên quan.
- [ ] 15/02: chốt báo cáo LG-01, LG-02, LG-05, LG-08; chuyển kết quả cho T07-05 (bản RC dùng cho UAT) và T07-06.

## 6. Tiêu chí hoàn thành

- [ ] **LG-02:** golden set ≥ 100 câu đúng phân bố; NFR-002 đạt trên phiếu SME; Trưởng nhóm BD ký phiếu.
- [ ] **LG-05:** E2E J1 + mọi story P0 xanh trên staging; coverage `domain` + `application` ≥ 70%; 23/23 EC có test case và đã chạy, kết quả ghi trong ma trận.
- [ ] **LG-01 (tổng hợp, đề xuất):** báo cáo AC: 100% AC P0 đạt; ≥ 90% AC P1 đạt hoặc hoãn có chấp thuận.
- [ ] **LG-08 (kiểm tra, đề xuất):** 100% sự kiện P0 ghi nhận đúng schema trên staging; trang Thống kê hiển thị đúng.
- [ ] Mọi lỗi phát hiện có Sev; danh sách Sev-1/Sev-2 mở chuyển cho T07-06 (LG-06).

## 7. Kiểm thử

Task này là kiểm thử. Định nghĩa Sev (đề xuất): **Sev-1** mất/lộ dữ liệu, không đăng nhập/hỏi được; **Sev-2** AC P0 trượt, câu trả lời sai có trích dẫn sai có hệ thống, EC chặn hành trình J1; **Sev-3** AC P1/P2 trượt có cách khắc phục, lỗi hiển thị; **Sev-4** thẩm mỹ.

## 8. Analytics / observability

- Kiểm tra sự kiện như §4.5. Run golden set gắn `run_id` vào log để tách khỏi số liệu sử dụng; tài khoản eval thuộc nhóm `cwd-test` (OQ-161).

## 9. Tham chiếu

- PRD §4.7 NFR-002, NFR-007, NFR-008, §5.2 EC-01..EC-23, §6.1 LG-01, LG-02, LG-05, LG-06, LG-08, §6.2.
- USER_STORIES EN-02, §10 DoD; IMPLEMENTATION_PLAN §4 S7, §6, §9.2.
- SAD §11.3 (chất lượng AI); Blueprint §3.4 (UF-01..UF-08).

## 10. Giả định và câu hỏi mở

- Giả định: SME có 8 giờ trong 11–12/02 (sau Tết) — cần xác nhận với Trưởng nhóm BD trước 29/01.
- Giả định: golden set chứa tài liệu thật chỉ khi OQ-005/OQ-025 cho phép; nếu không, LG-02 đo trên bộ PDF mẫu và ghi rõ hạn chế trong báo cáo.
- **OQ-176 (mới):** README gán LG-01 và LG-08 cho S7 ở đâu? Đề xuất task này lập báo cáo AC và checklist sự kiện; nếu PO muốn tách, cần thêm task. Owner: PO + QA lead.
- OQ-010, OQ-027 (kế thừa): ngưỡng NFR-002 và phân bố golden set là "(đề xuất)".
