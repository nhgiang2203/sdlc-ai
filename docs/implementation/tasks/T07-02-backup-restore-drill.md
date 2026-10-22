# T07-02 — Diễn tập sao lưu và khôi phục + runbook

| Thuộc tính | Giá trị |
|---|---|
| Sprint | S7 (01/02 – 19/02/2027) — diễn tập tuần 01/02 – 03/02; runbook hoàn thiện trước 18/02 |
| Story / WP | EN-05 · LG-09 |
| Loại | DevOps |
| Ước lượng | 2 ngày công |
| Phụ thuộc | [T05-08](T05-08-prod-provisioning.md) (prod + cấu hình pgBackRest, object versioning, sao chép đêm); [T06-04](T06-04-metrics-dashboards-alerts.md) (cảnh báo backup thất bại, mục runbook từng cảnh báo) |
| Chặn | [T07-06](T07-06-gate-review.md) |
| Trạng thái | Todo |

## 1. Mục tiêu

Chứng minh khôi phục được toàn bộ dữ liệu nghiệp vụ (PostgreSQL + PDF trong object storage) từ backup sang **môi trường riêng** trong **≤ 4 giờ** (RTO) với mất dữ liệu **≤ 15 phút** cho CSDL (RPO) và ≤ 24 giờ cho object (đề xuất, OQ-014); viết và cho review **runbook vận hành** (khôi phục, sự cố thường gặp, quy trình xử lý sự cố) làm bằng chứng LG-09.

## 2. Bối cảnh

- EN-05: "Diễn tập khôi phục từ backup trên môi trường riêng trong ≤ 4 giờ; runbook được review". NFR-004: khôi phục dịch vụ ≤ 4 giờ.
- SAD §4.3: pgBackRest full hằng tuần, differential hằng đêm, lưu trữ WAL liên tục → RPO ≤ 15 phút; bản sao sang kho backup IT; object versioning + sao chép hằng đêm. §11.1: backup mã hoá `repo-cipher-type=aes-256-cbc`. §11.2: "diễn tập khôi phục trước go-live và mỗi quý"; bảng SPOF (VM-DATA restore pgBackRest; VM-APP dựng lại từ Ansible ≤ 1 giờ; Valkey không backup, job được `retention_sweep` xếp lại). §7.4: backup hết hạn vòng 30 ngày.
- LG-09 yêu cầu "quy trình xử lý sự cố đã có" — IMPLEMENTATION_PLAN S7 tuần 15/02 – 18/02 ghi "runbook sự cố"; task này là chủ của runbook.

## 3. Phạm vi

**Trong phạm vi:** kế hoạch diễn tập, dựng VM khôi phục, restore PITR PostgreSQL, restore object, kiểm tra nhất quán, smoke test ứng dụng trên bản khôi phục, đo RTO/RPO, biên bản; runbook `docs/runbooks/` (DR, vận hành, xử lý sự cố); lịch diễn tập hằng quý.

**Ngoài phạm vi:** cấu hình backup ban đầu (T05-08); HA/replica (ngoài MVP, SAD §11.2); cảnh báo (T06-04 — chỉ liên kết); quy trình sự cố bảo mật của tổ chức (Bảo mật thông tin sở hữu — chỉ tham chiếu, RSK-002).

## 4. Thiết kế chi tiết

### 4.1 Môi trường diễn tập

- VM `vm-restore` (đề xuất: tạm mượn VM staging hoặc VM mới cùng cấu hình VM-DATA 4 vCPU/16 GB/SSD 300 GB) trong VLAN cô lập, **không** có route tới IdP prod/Claude; bucket `cwd-restore-drill` riêng.
- Ansible playbook `deploy/ansible/restore-drill.yml` dựng PostgreSQL 16 + pgvector + pgBackRest cùng phiên bản prod (khoá phiên bản).
- Bản khôi phục chứa dữ liệu thật (nếu prod đã có) → áp quyền truy cập như prod, xoá sau diễn tập (biên bản xoá).

### 4.2 Kịch bản và các bước

Kịch bản: "VM-DATA hỏng hoàn toàn lúc T0; khôi phục tới thời điểm gần nhất". Chuẩn bị trước T0 (trên prod, ngoài giờ làm việc): tạo **marker** — ghi một dòng `ops.drill_marker(id, created_at)` (bảng tạm, đề xuất) mỗi phút trong 30 phút trước T0; tải 3 PDF marker có sha256 đã biết.

| # | Bước | Lệnh / thao tác chính | Ghi thời điểm |
|---|---|---|---|
| 1 | Tuyên bố sự cố, bắt đầu đồng hồ RTO | Người chỉ huy diễn tập ghi T0 | T0 |
| 2 | Dựng VM khôi phục | `ansible-playbook restore-drill.yml -l vm-restore` | T1 |
| 3 | Lấy thông tin backup | `pgbackrest --stanza=cwd info` (xác nhận full + diff + WAL gần nhất, mã hoá) | T2 |
| 4 | Restore PITR | `pgbackrest --stanza=cwd --delta --type=time --target="<T0 − 1 phút>" --target-action=promote restore` | T3 |
| 5 | Khởi động, chờ replay WAL | `pg_ctl start`; theo dõi log tới "database system is ready" | T4 |
| 6 | Kiểm tra CSDL | `SELECT max(created_at) FROM ops.drill_marker` → **RPO = T0 − max**; đếm bảng chính so với số chụp lúc T0 (`docs.documents`, `docs.chunks`, `conv.messages`, `ops.audit_log`); `amcheck` trên chỉ mục btree; `SELECT count(*) FROM docs.chunks WHERE embedding IS NULL` = 0; truy vấn HNSW mẫu trả kết quả | T5 |
| 7 | Restore object | Sao chép bucket backup đêm → `cwd-restore-drill`, sau đó áp version mới nhất từ bucket prod (versioning) nếu còn truy cập; kiểm sha256 3 PDF marker | T6 |
| 8 | Đối chiếu CSDL ↔ object | Script `deploy/ops/check_object_consistency.py`: mọi `docs.documents` `READY` có object `documents/{id}.pdf`; báo cáo thiếu/thừa | T7 |
| 9 | Dựng ứng dụng trỏ vào bản khôi phục | Compose `prod-app.yml` với biến môi trường drill, Valkey mới rỗng, `FakeLLMAdapter` hoặc key staging | T8 |
| 10 | Smoke test | `/readyz` 200; đăng nhập (Keycloak drill); mở danh sách tài liệu; hỏi 5 câu golden set có đáp án (Fake hoặc Claude staging); mở trang PDF trích dẫn; `retention_sweep` chạy xếp lại job `QUEUED` | T9 = kết thúc RTO |
| 11 | Dọn dẹp | Xoá VM/bucket drill, xoá `ops.drill_marker` trên prod; biên bản | — |

**Đạt:** T9 − T0 ≤ 4 giờ; RPO CSDL ≤ 15 phút; 0 object `READY` bị thiếu so với backup đêm (chấp nhận thiếu object tải lên sau lần sao chép đêm — đúng RPO 24 giờ của object, ghi rõ số lượng).

### 4.3 Runbook (`docs/runbooks/`)

| File | Nội dung |
|---|---|
| `README.md` | Danh bạ (người trực, IT, Bảo mật, Anthropic support), mức độ sự cố Sev-1..Sev-4, kênh liên lạc, quy trình chung: phát hiện → phân loại → thông báo người dùng (banner/email mẫu) → khắc phục → post-mortem trong 5 ngày làm việc |
| `dr-restore.md` | Các bước §4.2 cho tình huống thật: restore tại chỗ vs VM mới, đổi DNS/cấu hình PgBouncer, kiểm tra sau khôi phục |
| `alerts.md` | (T06-04) mục cho từng cảnh báo A1–A9 — task này review và liên kết |
| `incidents.md` | Playbook: Claude API lỗi/circuit mở (EC-07, kiểm tra trạng thái Anthropic, egress proxy); model server lỗi (chế độ `degraded`, restart TEI); hàng đợi ứ/worker treo; Valkey restart (mất phiên — thông báo người dùng); đĩa đầy (WAL, Loki); chi phí vượt ngưỡng (giảm rate limit qua cấu hình); nghi rò rỉ dữ liệu/truy cập trái phép → chuyển ngay quy trình của Bảo mật thông tin, tạm khoá dịch vụ (RSK-002); gỡ khẩn tài liệu nhạy cảm (gỡ + purge + kiểm tra backup hết hạn 30 ngày) |
| `deploy-rollback.md` | Deploy rolling, rollback về tag trước, migration expand/contract (SAD §11.2) |
| `secrets-rotation.md` | Xoay Claude API key 90 ngày, mật khẩu CSDL 180 ngày (SAD §11.1) |

Review: Trưởng nhóm Dev + một DevOps không viết runbook làm thử bước `dr-restore.md` (người khác đọc làm được = đạt). Lịch diễn tập quý tiếp theo: tuần 2 tháng 5/2027 (đề xuất).

## 5. Các bước thực hiện

- [ ] Gửi kế hoạch diễn tập cho IT (cần quyền đọc kho backup, VM tạm) trước 27/01.
- [ ] Viết playbook `restore-drill.yml`, script đối chiếu object, script marker.
- [ ] Chạy diễn tập 01/02 hoặc 02/02 (ngoài giờ làm việc nếu chạm prod), ghi thời gian từng bước.
- [ ] Lập biên bản; nếu trượt RTO/RPO → phân tích, sửa (ví dụ tăng tần suất `archive-push`, `archive_timeout = 60s`), diễn tập lại sau Tết (11/02).
- [ ] Viết runbook; review chéo trước 17/02.
- [ ] Lưu bằng chứng `docs/evidence/LG-09/restore-drill-<ngày>.md`, ảnh chụp, log lệnh.

## 6. Tiêu chí hoàn thành

- [ ] **EN-05:** khôi phục từ backup trên môi trường riêng hoàn tất trong ≤ 4 giờ (biên bản có T0..T9).
- [ ] **EN-05 / NFR-004:** RPO CSDL đo được ≤ 15 phút (marker); RPO object ≤ 24 giờ (đề xuất).
- [ ] **EN-05:** runbook được review và ký bởi Trưởng nhóm Dev.
- [ ] **LG-09:** quy trình xử lý sự cố (`docs/runbooks/README.md`, `incidents.md`) có và đã được đội trực đọc.
- [ ] Backup được xác nhận mã hoá (`pgbackrest info` hiển thị cipher) và có bản sao ở kho backup IT.

## 7. Kiểm thử

Mẫu **biên bản diễn tập khôi phục**:

| Mục | Nội dung |
|---|---|
| Ngày, người chỉ huy, người tham gia | |
| Phiên bản PostgreSQL/pgBackRest, backup dùng (label full/diff, WAL cuối) | |
| T0..T9 và thời lượng từng bước | |
| RTO đo được / mục tiêu 4 giờ | Đạt / Không đạt |
| RPO CSDL đo được / mục tiêu 15 phút | Đạt / Không đạt |
| Object: tổng, khớp, thiếu (lý do) | |
| Kết quả smoke test (5 câu hỏi, mở PDF) | |
| Vấn đề phát hiện, hành động khắc phục, owner, hạn | |
| Xác nhận đã xoá dữ liệu drill | |
| Chữ ký Trưởng nhóm Dev | |

## 8. Analytics / observability

- Xác nhận cảnh báo A7 "backup thất bại" (T06-04) bằng cách làm lỗi tạm `archive-push` trên staging.
- Dashboard hạ tầng có panel "backup thành công gần nhất" và "độ trễ lưu trữ WAL" (`pg_stat_archiver.last_archived_time`) để theo dõi RPO liên tục.
- Không có sự kiện EV.

## 9. Tham chiếu

- USER_STORIES EN-05; PRD §4.7 NFR-004, §6.1 LG-09; IMPLEMENTATION_PLAN §4 S7, §9.2.
- SAD §4.3, §7.4, §11.1 (mã hoá backup, xoay secret), §11.2 (RTO/RPO, SPOF, triển khai), §13.1 (kho backup IT).

## 10. Giả định và câu hỏi mở

- Giả định: T05-08 đã cấu hình `archive_mode=on`, `archive_command` pgBackRest, lịch full/diff qua cron/systemd timer, versioning bucket.
- Giả định: diễn tập trước Tết; nếu prod chưa có dữ liệu thật, dữ liệu là bộ seed của T07-01 (chạy diễn tập **trước** bước dọn dữ liệu test tải để có khối lượng đại diện — đề xuất).
- OQ-014 (kế thừa): RTO/RPO chính thức, đặc biệt RPO object 24 giờ.
- **OQ-174 (mới):** IT có cho đội dev quyền đọc kho backup để tự diễn tập, hay IT phải thực hiện bước restore? Ảnh hưởng thời gian RTO. Owner: IT.
