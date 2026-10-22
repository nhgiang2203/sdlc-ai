/* Shared prototype runtime — Chat với tài liệu
   AppShell, biểu tượng, vai trò demo, toast, banner mất kết nối, analytics giả lập. */
(function () {
  "use strict";

  // ---------- Icons (SVG nét, phong cách Lucide) ----------
  const P = {
    logo: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/>',
    file: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
    upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M5 20h14"/>',
    check: '<path d="m5 12 5 5 9-10"/>',
    checkCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    alert: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17h.01"/>',
    alertCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
    loader: '<path d="M12 3a9 9 0 1 0 9 9"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    send: '<path d="M5 12h14"/><path d="m13 6 6 6-6 6"/>',
    stop: '<rect x="7" y="7" width="10" height="10" rx="1.5"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a1 1 0 0 1 1-1h10"/>',
    thumbUp: '<path d="M7 11v9H4v-9h3z"/><path d="M7 11l4-8a2 2 0 0 1 2 2v4h5a2 2 0 0 1 2 2.3l-1.2 7A2 2 0 0 1 16.8 20H7"/>',
    thumbDown: '<path d="M7 13V4H4v9h3z"/><path d="M7 13l4 8a2 2 0 0 0 2-2v-4h5a2 2 0 0 0 2-2.3l-1.2-7A2 2 0 0 0 16.8 4H7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    log: '<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
    chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
    logout: '<path d="M15 4h4v16h-4"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h10"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
    chevronLeft: '<path d="m15 6-6 6 6 6"/>',
    arrowUp: '<path d="M12 19V5"/><path d="m5 12 7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
    chevronRight: '<path d="m9 6 6 6-6 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>',
    wifiOff: '<path d="M2 8.5a15 15 0 0 1 4.5-2.8M10 5a15 15 0 0 1 12 3.5"/><path d="M5 12.5a10 10 0 0 1 4-2.2M14.5 10.4A10 10 0 0 1 19 12.5"/><path d="M8.5 16a5 5 0 0 1 7 0"/><path d="M12 20h.01"/><path d="M3 3l18 18"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    sparkle: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>',
    sliders: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
    layout: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>'
  };
  function icon(name, cls) {
    return '<svg class="icon ' + (cls || "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + (P[name] || "") + "</svg>";
  }

  // ---------- Safe storage (Blueprint §3.5.2) ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    sget(k, d) { try { const v = sessionStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    sset(k, v) { try { sessionStorage.setItem(k, v); } catch (e) { /* ignore */ } },
    sdel(k) { try { sessionStorage.removeItem(k); } catch (e) { /* ignore */ } }
  };

  // ---------- Demo roles ----------
  const ROLES = {
    user: { name: "Nguyễn Thu Hà", initials: "TH", label: "Chuyên viên BD", roles: ["user"] },
    lead: { name: "Trần Quốc Bảo", initials: "QB", label: "Trưởng nhóm BD", roles: ["user", "lead"] },
    manager: { name: "Lê Minh Châu", initials: "MC", label: "Quản lý", roles: ["user", "manager"] }
  };
  function currentRoleKey() {
    const q = new URLSearchParams(location.search).get("role");
    if (q && ROLES[q]) { store.set("cwd.demo.role", q); return q; }
    const s = store.get("cwd.demo.role", "lead");
    return ROLES[s] ? s : "lead";
  }
  function session() {
    const key = currentRoleKey();
    const r = ROLES[key];
    return { key, name: r.name, initials: r.initials, label: r.label, roles: r.roles, canAudit: r.roles.includes("lead"), canStats: r.roles.includes("manager") };
  }
  function setRole(key) { store.set("cwd.demo.role", key); const u = new URL(location.href); u.searchParams.delete("role"); location.href = u.toString(); }

  // ---------- AppShell ----------
  function renderHeader(active) {
    const s = session();
    const links = [
      { id: "workspace", href: "workspace.html", icon: "chat", label: "Hỏi đáp", show: true },
      { id: "history", href: "history.html", icon: "history", label: "Lịch sử", show: true },
      { id: "audit", href: "audit.html", icon: "log", label: "Nhật ký tài liệu", show: s.canAudit },
      { id: "stats", href: "stats.html", icon: "chart", label: "Thống kê", show: s.canStats }
    ];
    const nav = links.filter(l => l.show).map(l =>
      '<a href="' + l.href + '" title="' + l.label + '"' + (l.id === active ? ' aria-current="page"' : "") + ">" + icon(l.icon) + '<span class="nav-label">' + l.label + "</span></a>").join("");
    const header = document.createElement("header");
    header.className = "app-header";
    header.innerHTML =
      '<a class="brand" href="index.html"><span class="brand-mark">' + icon("logo", "icon-sm") + "</span><span>Chat với tài liệu</span></a>" +
      '<nav class="main-nav" aria-label="Điều hướng chính">' + nav + "</nav>" +
      '<div class="header-spacer"></div>' +
      '<div class="user-chip"><span class="avatar" aria-hidden="true">' + s.initials + '</span><span class="user-meta"><span>' + s.name + "</span><small>" + s.label + "</small></span>" +
      '<a class="icon-btn" href="login.html?state=logged_out" title="Đăng xuất" aria-label="Đăng xuất">' + icon("logout") + "</a></div>";
    const skip = document.createElement("a");
    skip.className = "skip-link"; skip.href = "#main"; skip.textContent = "Bỏ qua tới nội dung chính";
    const banner = document.createElement("div");
    banner.id = "offline-banner"; banner.className = "banner banner-warning"; banner.setAttribute("role", "status"); banner.hidden = true;
    banner.innerHTML = icon("wifiOff") + "<span>Mất kết nối. Câu hỏi của bạn vẫn được giữ lại — hệ thống sẽ cho phép gửi khi có mạng trở lại.</span>";
    document.body.prepend(skip, header, banner);
    window.addEventListener("online", () => setOffline(false));
    window.addEventListener("offline", () => setOffline(true));
    if (!navigator.onLine) setOffline(true);
    return s;
  }
  const offlineListeners = [];
  let offline = false;
  function setOffline(v) {
    offline = v;
    const b = document.getElementById("offline-banner");
    if (b) b.hidden = !v;
    document.dispatchEvent(new CustomEvent("cwd:connectivity", { detail: { offline: v } }));
    offlineListeners.forEach(fn => fn(v));
  }

  // ---------- Toast ----------
  function toast(message, tone, action) {
    let region = document.getElementById("toast-region");
    if (!region) {
      region = document.createElement("div");
      region.id = "toast-region"; region.className = "toast-region";
      region.setAttribute("role", "status"); region.setAttribute("aria-live", "polite");
      document.body.appendChild(region);
    }
    const el = document.createElement("div");
    el.className = "toast toast-" + (tone || "info");
    const lead = tone === "success" ? "checkCircle" : tone === "danger" ? "alertCircle" : "info";
    el.innerHTML = '<span class="icon-lead">' + icon(lead) + "</span>";
    const span = document.createElement("span"); span.textContent = message; el.appendChild(span);
    if (action) {
      const b = document.createElement("button"); b.className = "btn btn-sm btn-ghost"; b.style.color = "inherit"; b.textContent = action.label;
      b.addEventListener("click", () => { action.onClick(); el.remove(); }); el.appendChild(b);
    }
    const close = document.createElement("button"); close.className = "icon-btn"; close.setAttribute("aria-label", "Đóng thông báo"); close.innerHTML = icon("x", "icon-sm");
    close.addEventListener("click", () => el.remove()); el.appendChild(close);
    region.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  // ---------- Dialog (focus trap, Esc) ----------
  function confirmDialog(opts) {
    return new Promise(resolve => {
      const prev = document.activeElement;
      const back = document.createElement("div"); back.className = "dialog-backdrop";
      back.innerHTML = '<div class="dialog" role="alertdialog" aria-modal="true" aria-labelledby="dlg-t" aria-describedby="dlg-b"><h2 id="dlg-t"></h2><p id="dlg-b" class="muted"></p><div class="dialog-actions"><button class="btn btn-secondary" data-act="cancel"></button><button class="btn" data-act="ok"></button></div></div>';
      back.querySelector("#dlg-t").textContent = opts.title;
      back.querySelector("#dlg-b").textContent = opts.body;
      const ok = back.querySelector('[data-act="ok"]'); const cancel = back.querySelector('[data-act="cancel"]');
      ok.textContent = opts.confirmLabel || "Đồng ý"; ok.classList.add(opts.tone === "danger" ? "btn-danger" : "btn-primary");
      cancel.textContent = opts.cancelLabel || "Huỷ";
      function done(v) { back.remove(); document.removeEventListener("keydown", onKey); if (prev && prev.focus) prev.focus(); resolve(v); }
      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); done(false); }
        if (e.key === "Tab") { const f = [cancel, ok]; const i = f.indexOf(document.activeElement); e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus(); }
      }
      ok.addEventListener("click", () => done(true)); cancel.addEventListener("click", () => done(false));
      back.addEventListener("click", e => { if (e.target === back) done(false); });
      document.addEventListener("keydown", onKey);
      document.body.appendChild(back); cancel.focus();
    });
  }

  // ---------- Analytics giả lập (PRD §6.2) — chỉ metadata, không nội dung ----------
  function track(name, props) {
    // Prototype: ghi ra console để kiểm tra tên sự kiện và thuộc tính.
    // eslint-disable-next-line no-console
    console.info("[analytics]", name, props || {});
  }

  // ---------- Utils ----------
  function fold(s) { return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase(); }
  function esc(s) { const d = document.createElement("div"); d.textContent = s == null ? "" : String(s); return d.innerHTML; }
  function fmtBytes(b) { return b >= 1048576 ? (b / 1048576).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1024)) + " KB"; }
  function demoPanel(title, buildFn) {
    const toggle = document.createElement("button");
    toggle.className = "btn btn-secondary demo-toggle"; toggle.setAttribute("aria-expanded", "false"); toggle.setAttribute("aria-controls", "demo-panel");
    toggle.innerHTML = icon("sliders") + "Bảng demo";
    const panel = document.createElement("div"); panel.id = "demo-panel"; panel.className = "demo-panel"; panel.hidden = true;
    panel.setAttribute("role", "region"); panel.setAttribute("aria-label", "Bảng điều khiển demo");
    panel.innerHTML = "<h2>" + esc(title) + '</h2><p class="demo-note">Chỉ có trong prototype — dùng để xem các trạng thái. Không thuộc sản phẩm thật.</p>';
    const roleField = document.createElement("div"); roleField.className = "field";
    roleField.innerHTML = '<label for="demo-role">Vai trò đăng nhập</label><select id="demo-role" class="input"><option value="user">Chuyên viên BD</option><option value="lead">Trưởng nhóm BD</option><option value="manager">Quản lý</option></select>';
    panel.appendChild(roleField);
    const sel = roleField.querySelector("select"); sel.value = currentRoleKey(); sel.addEventListener("change", () => setRole(sel.value));
    const themeField = document.createElement("div"); themeField.className = "field";
    themeField.innerHTML = '<label for="demo-theme">Giao diện</label><select id="demo-theme" class="input"><option value="system">Theo hệ thống</option><option value="light">Sáng</option><option value="dark">Tối</option></select>';
    panel.appendChild(themeField);
    const tsel = themeField.querySelector("select"); tsel.value = store.get("cwd.demo.theme", "system");
    tsel.addEventListener("change", () => { store.set("cwd.demo.theme", tsel.value); applyTheme(); });
    if (buildFn) buildFn(panel);
    toggle.addEventListener("click", () => { panel.hidden = !panel.hidden; toggle.setAttribute("aria-expanded", String(!panel.hidden)); });
    document.body.append(toggle, panel);
  }
  function applyTheme() {
    const t = store.get("cwd.demo.theme", "system");
    if (t === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", t);
  }
  applyTheme();

  window.CWD = { icon, store, session, renderHeader, toast, confirmDialog, track, fold, esc, fmtBytes, demoPanel, setOffline, isOffline: () => offline, ROLES };
})();
