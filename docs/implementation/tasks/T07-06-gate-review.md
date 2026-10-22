# T07-06 — Hồ sơ và buổi Gate review

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — hồ sơ chốt 18/02, **Gate review 19/02/2027** (M5) |
| Story / WP | LG-01..LG-10 |
| Loại | PO |
| Ước lượng | 1 ngày công |
| Phụ thuộc | [T07-01](T07-01-load-test.md), [T07-02](T07-02-backup-restore-drill.md), [T07-03](T07-03-security-testing.md), [T07-04](T07-04-final-regression.md), [T07-05](T07-05-uat-user-guide.md); bằng chứng S6 từ [T06-01](T06-01-weekly-stats-api.md), [T06-02](T06-02-fe-stats-page.md), [T06-04](T06-04-metrics-dashboards-alerts.md) |
| Chặn | — (kết quả quyết định mở pilot 22/02/2027) |
| Trạng thái | Todo |

## 1. Mục tiêu

Tập hợp hồ sơ bằng chứng cho từng tiêu chí LG-01..LG-10 (PRD §6.1), tổ chức buổi Gate review ngày 19/02/2027 với QA lead, Trưởng nhóm BD, Trưởng nhóm Dev, Bảo mật thông tin, Pháp chế, PO, và lập biên bản quyết định **Đạt / Đạt có điều kiện / Không đạt** có chữ ký từng người ký. Exit criteria M5: mọi LG đạt và có người ký; 0 lỗi Sev-1/Sev-2 mở (LG-06).

## 2. Bối cảnh

- PRD §6.1: "Sản phẩm chỉ được đưa vào pilot khi **mọi** tiêu chí dưới đây đạt. Ngưỡng `(đề xuất)` cần sponsor chốt trước Gate review" (OQ-027).
- IMPLEMENTATION_PLAN §9.2 (LG → bằng chứng → sprint), §5.1 (các OQ chặn LG), §4 Pilot (22/02 – 19/03, báo cáo sponsor 26/03).
- LG-06 (bug tracker, PO ký) không có task kiểm thử riêng — task này lấy số liệu từ bug tracker.

## 3. Phạm vi

**Trong phạm vi:** thư mục hồ sơ `docs/evidence/`, bảng tổng hợp LG, kiểm tra đủ bằng chứng (pre-gate 17/02), lịch họp và tài liệu gửi trước, điều phối buổi họp, biên bản, theo dõi điều kiện (nếu "Đạt có điều kiện"), cập nhật lịch sử thay đổi IMPLEMENTATION_PLAN, thông báo kết quả.

**Ngoài phạm vi:** tạo bằng chứng (các task T06/T07); quyết định chính sách (OQ-005, OQ-019 — Bảo mật/Pháp chế); tổ chức pilot (sau Gate).

## 4. Thiết kế chi tiết

### 4.1 Cấu trúc hồ sơ

```text
docs/evidence/
├── README.md              # bảng tổng hợp LG (mẫu §4.2), phiên bản RC, link mọi bằng chứng
├── LG-01/ac-report.md                     # T07-04
├── LG-02/golden-set-final.md, sme-scoring-sheet.(xlsx|pdf)   # T07-04
├── LG-03/performance-report.md            # T07-01
├── LG-04/security-review.md, pentest-report.pdf, authz-matrix-results.md   # T07-03
├── LG-05/coverage.html, e2e-report/, ec-matrix.md            # T07-04
├── LG-06/bug-snapshot-<ngày>.csv, sev3-plan.md               # T07-06
├── LG-07/uat-report.md                                       # T07-05
├── LG-08/event-check.md, stats-page-screenshots/             # T07-04, T06-01, T06-02
├── LG-09/alerts-firing-<ngày>.md, restore-drill-<ngày>.md, runbooks.md (link), cost-threshold.md   # T06-04, T07-02
└── LG-10/huong-dan-1-trang.pdf, gioi-thieu-attendance.md     # T07-05
```

Bằng chứng không chứa nội dung tài liệu mật hay câu hỏi thật (ảnh chụp đã che nếu cần). Bản pentest có thể chỉ lưu tóm tắt nếu Bảo mật yêu cầu giữ bản đầy đủ riêng.

### 4.2 Bảng tổng hợp LG (mẫu)

| LG | Tiêu chí (PRD §6.1) | Ngưỡng đã chốt (OQ-027) | Bằng chứng | Task | Kết quả đo | Người ký | Trạng thái |
|---|---|---|---|---|---|---|---|
| LG-01 | 100% AC 9 story P0; ≥ 90% AC P1 hoặc hoãn được chấp thuận | | `LG-01/ac-report.md` | T07-04 | P0 x/x, P1 y% | QA lead | |
| LG-02 | NFR-002 trên golden set ≥ 100 câu đúng phân bố | ≥ 85% / ≥ 90% / 0 | `LG-02/*` | T07-04 | | Trưởng nhóm BD | |
| LG-03 | NFR-001, NFR-005; NFR-006 trong test tải | p90 3 s/15 s; 3/15 phút; 20 người, 500 tài liệu | `LG-03/performance-report.md` | T07-01 | | Trưởng nhóm Dev | |
| LG-04 | NFR-003 ký; Pháp chế OQ-019; phân quyền 100%; 0 Critical/High | | `LG-04/*` | T07-03 | | Bảo mật, Pháp chế | |
| LG-05 | E2E J1 + P0; coverage ≥ 70%; EC-01..EC-23 đã chạy | 70% | `LG-05/*` | T07-04 | | QA lead | |
| LG-06 | 0 Sev-1/Sev-2 mở; Sev-3 có kế hoạch | | `LG-06/*` | T07-06 | | PO | |
| LG-07 | ≥ 5 người BD làm J1 tài liệu thật; ≥ 4/5 không trợ giúp | | `LG-07/uat-report.md` | T07-05 | | Trưởng nhóm BD | |
| LG-08 | 100% sự kiện P0 trên staging; trang Thống kê đúng | | `LG-08/*` | T07-04, T06-01/02 | | PO | |
| LG-09 | Giám sát sẵn sàng/lỗi; cảnh báo AI lỗi; ngưỡng chi phí tháng; quy trình sự cố | | `LG-09/*` | T06-04, T07-02 | | Trưởng nhóm Dev | |
| LG-10 | Hướng dẫn 1 trang + buổi giới thiệu, nêu BRU-006 | | `LG-10/*` | T07-05 | | PO | |

Trạng thái: ✔ Đạt · ◐ Đạt có điều kiện (ghi điều kiện, owner, hạn ≤ trước 22/02) · ✘ Không đạt.

### 4.3 Checklist trước Gate (pre-gate 17/02, 30 phút PO + QA lead + Tech lead)

- [ ] Mọi OQ chặn LG đã có quyết định: OQ-005, OQ-009, OQ-010, OQ-019, OQ-027, OQ-030, OQ-031, OQ-013 (hoặc phương án tạm được chấp thuận).
- [ ] Mỗi dòng bảng §4.2 có link bằng chứng mở được và ngày tạo ≥ ngày deploy RC.
- [ ] RC trên prod = RC đã kiểm thử (`git-sha` khớp trong mọi báo cáo).
- [ ] Snapshot bug tracker: số Sev-1/Sev-2 mở = 0; danh sách Sev-3 có kế hoạch PO duyệt.
- [ ] Story P1/P2 bị cắt hoặc hoãn (US-022 nếu OQ-035 từ chối, …) được ghi kèm chấp thuận sponsor.
- [ ] Dữ liệu test tải/UAT đã dọn hoặc được gắn nhãn (OQ-161).
- [ ] Tài liệu gửi người tham dự trước 24 giờ (18/02).

### 4.4 Buổi Gate review (19/02/2027, 90 phút — đề xuất)

| Phút | Nội dung |
|---|---|
| 0–10 | PO: mục tiêu, phạm vi MVP đã giao, thay đổi phạm vi so với kế hoạch |
| 10–70 | Đi lần lượt LG-01..LG-10: chủ bằng chứng trình bày 5 phút, người ký xác nhận Đạt/Điều kiện/Không đạt |
| 70–80 | Rủi ro còn lại cho pilot (RSK-001, RSK-002, RSK-006, RSK-009…), kế hoạch hỗ trợ pilot, nhịp xem số liệu hằng tuần |
| 80–90 | Quyết định chung; ghi điều kiện; xác nhận ngày mở pilot 22/02 |

Quy tắc quyết định: bất kỳ LG nào ✘ → **Không đạt** (dời pilot, lập kế hoạch khắc phục và ngày Gate lại); chỉ ◐ với điều kiện đóng được trước 22/02 → **Đạt có điều kiện**; PO theo dõi đóng điều kiện và thông báo bằng văn bản.

## 5. Các bước thực hiện

- [ ] 01/02: tạo `docs/evidence/` và bảng §4.2 rỗng; giao chủ từng dòng; gửi lời mời họp 19/02 (trước Tết để giữ lịch).
- [ ] 12/02: kiểm tra tiến độ bằng chứng; nhắc Pháp chế hạn OQ-019/OQ-030 (12/02).
- [ ] 16/02: xuất snapshot bug tracker → `LG-06/`; soạn `sev3-plan.md`.
- [ ] 17/02: pre-gate theo checklist §4.3; xử lý thiếu sót.
- [ ] 18/02: gửi hồ sơ.
- [ ] 19/02: điều phối buổi họp, lập biên bản, thu chữ ký (ký số hoặc email xác nhận được lưu).
- [ ] 19/02: cập nhật trạng thái README danh mục task, ghi lịch sử thay đổi IMPLEMENTATION_PLAN; thông báo kết quả cho sponsor và đội BD.

## 6. Tiêu chí hoàn thành

- [ ] **LG-01..LG-10:** mỗi tiêu chí có bằng chứng đính kèm và chữ ký người ký theo PRD §6.1.
- [ ] **LG-06:** snapshot bug tracker ngày Gate có 0 Sev-1/Sev-2 mở; Sev-3 có kế hoạch PO chấp thuận.
- [ ] Biên bản Gate review có quyết định rõ ràng và danh sách điều kiện (nếu có) với owner + hạn.
- [ ] Hồ sơ lưu trữ trong repo (hoặc kho tài liệu tổ chức, link từ `docs/evidence/README.md`).

## 7. Kiểm thử

Mẫu **biên bản Gate review** (`docs/evidence/gate-review-2027-02-19.md`):

1. Thông tin: ngày, thành phần tham dự (tên, vai trò), vắng mặt và ủy quyền.
2. Phiên bản: RC `git-sha`, `prompt_version`, model, ngày deploy prod.
3. Bảng §4.2 đã điền kết quả và trạng thái.
4. Ngưỡng "(đề xuất)" đã được sponsor chốt (tham chiếu quyết định OQ-027).
5. Thay đổi phạm vi và story hoãn (kèm chấp thuận).
6. Rủi ro chấp nhận cho pilot + biện pháp.
7. **Quyết định:** Đạt / Đạt có điều kiện / Không đạt; điều kiện (mô tả, owner, hạn).
8. Chữ ký: QA lead, Trưởng nhóm BD, Trưởng nhóm Dev, Bảo mật thông tin, Pháp chế, Product owner.

## 8. Analytics / observability

- Xác nhận trước Gate: dashboard tổng quan và trang Thống kê sẵn sàng cho nhịp xem hằng tuần trong pilot (WAU, tỷ lệ not_found, hữu ích, độ trễ, chi phí — IMPLEMENTATION_PLAN Pilot).
- Không có sự kiện mới.

## 9. Tham chiếu

- PRD §6.1 LG-01..LG-10, §6.2, §8 (OQ chặn launch gate); USER_STORIES §10 DoD.
- IMPLEMENTATION_PLAN §0 (M5), §4 S7 + Pilot, §5.1, §5.3, §9.1, §9.2.
- BRD RSK-001, RSK-002; SAD §16.

## 10. Giả định và câu hỏi mở

- Giả định: tất cả người ký có mặt hoặc ủy quyền bằng văn bản ngày 19/02.
- Giả định: sponsor không tham dự Gate (PRD không liệt kê) nhưng phải chốt ngưỡng trước đó (OQ-027).
- **OQ-179 (mới):** Định nghĩa Sev-1..Sev-4 chính thức cho LG-06 (T07-04 đã đề xuất) cần PO + QA lead chốt trước 01/02/2027.
- **OQ-180 (mới):** Nếu "Đạt có điều kiện", ai có thẩm quyền xác nhận điều kiện đã đóng để mở pilot — PO một mình hay cần người ký LG liên quan? Owner: Executive sponsor.
