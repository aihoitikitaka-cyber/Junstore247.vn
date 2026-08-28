// recharge.js — Junstore247
//
// Toàn bộ luồng "Nạp Xu Thẻ Cào" (user) + "Duyệt Nạp" (admin), gọi thẳng
// Edge Function thật `manage-recharge` (đã mã hoá PIN/seri bằng AES-GCM,
// chống trùng thẻ, cộng Xu atomic qua RPC approve_coin_recharge).
//
// File này KHÔNG dùng localStorage để giả lập trạng thái — mọi trạng thái
// (pending / approved / rejected) đều lấy trực tiếp từ server. localStorage
// chỉ được dùng để nhớ *ID* của các yêu cầu đã gửi, để hỏi lại trạng thái
// (action "status") — không lưu PIN/seri ở máy client.
//
// Cần có sẵn trên window (được set trong <script type="module"> của
// junstore247.html): SUPABASE_URL, SUPABASE_KEY, callRechargeApi(),
// getStoredOrPromptPassword(), currentUser, updateUserUI(), supabase.

(function () {
  const NAP_HISTORY_KEY = "junstore_nap_history";
  const xuMap = { "10000": 33, "20000": 70, "50000": 180, "100000": 365, "200000": 750, "500000": 1900 };

  // Chọn nhà mạng / mệnh giá trên form nạp thẻ.
  window.selectedTelco = window.selectedTelco || "Viettel";
  window.selectedDenom = window.selectedDenom || "50000";

  window.selectTelco = function (el) {
    window.selectedTelco = el.dataset.telco;
    document.querySelectorAll(".telco").forEach((b) => b.classList.toggle("active", b === el));
  };

  window.selectDenom = function (val) {
    if (typeof val === "object" && val && val.dataset) val = val.dataset.value;
    window.selectedDenom = String(val);
    document.querySelectorAll(".denom").forEach((b) => b.classList.toggle("active", b.dataset.value === window.selectedDenom));
    document.querySelectorAll(".price-card").forEach((c) => {
      const onclickAttr = c.getAttribute("onclick") || "";
      const match = onclickAttr.match(/'(\d+)'/);
      if (match) c.classList.toggle("popular", match[1] === window.selectedDenom);
      else c.classList.remove("popular");
    });
  };

  function readHistory() {
    try { return JSON.parse(localStorage.getItem(NAP_HISTORY_KEY) || "[]"); } catch (_) { return []; }
  }
  function writeHistory(list) {
    try { localStorage.setItem(NAP_HISTORY_KEY, JSON.stringify(list.slice(0, 30))); } catch (_) {}
  }

  function renderNapHistory() {
    const box = document.getElementById("napHistory");
    if (!box) return;
    const list = readHistory();
    if (list.length === 0) {
      box.innerHTML = '<div class="empty-state" style="padding:18px"><p>Chưa có giao dịch nào. Nạp thẻ để thấy lịch sử.</p></div>';
      return;
    }
    box.innerHTML = list.slice(0, 8).map((it) => `
      <div class="history-item">
        <span style="width:36px;height:36px;display:grid;place-items:center;border-radius:10px;background:var(--paper2);border:1px solid var(--line);font-size:.8rem"><i class="fa-solid fa-credit-card" style="color:var(--violet)"></i></span>
        <div style="flex:1"><b>${it.telco} ${Number(it.menhgia).toLocaleString("vi-VN")}đ</b> <span style="color:var(--ink3);font-family:var(--font-mono);font-size:.72rem">• ${it.time}</span><div style="font-size:.76rem;color:var(--ink2)">Mã: ${it.requestCode || "—"} • +${it.xu} Xu</div></div>
        <span class="status-pill ${it.status === "ok" ? "ok" : it.status === "rejected" ? "" : "wait"}" style="${it.status === "rejected" ? "background:#ffe4e4;color:#b42318" : ""}">${it.status === "ok" ? "Thành công" : it.status === "rejected" ? "Bị từ chối" : "Đang xử lý"}</span>
      </div>
    `).join("");
  }
  window.renderNapHistory = renderNapHistory;

  // Đồng bộ trạng thái các thẻ "Đang xử lý" với server thật.
  async function syncNapHistoryStatus() {
    const list = readHistory();
    const pendingIds = list.filter((it) => it.status === "pending" && it.id).map((it) => it.id);
    if (!pendingIds.length || !window.callRechargeApi) return;
    let data;
    try { data = await window.callRechargeApi("status", { ids: pendingIds }); } catch (_) { return; }
    if (!data || !data.ok || !Array.isArray(data.requests) || !data.requests.length) return;
    const byId = Object.fromEntries(data.requests.map((r) => [r.id, r]));
    let changed = false;
    const updated = list.map((it) => {
      const fresh = byId[it.id];
      if (fresh && fresh.status !== "pending" && fresh.status !== it.status) {
        changed = true;
        return { ...it, status: fresh.status === "approved" ? "ok" : fresh.status };
      }
      return it;
    });
    if (changed) {
      writeHistory(updated);
      renderNapHistory();
      // Có thẻ vừa được duyệt → lấy lại số Xu thật từ DB (không tự cộng ở client).
      try {
        let user = null;
        try { user = JSON.parse(localStorage.getItem("junstore_user") || "null"); } catch (_) {}
        if (user && user.id && window.supabaseGlobal) {
          const { data: freshUser } = await window.supabaseGlobal.from("users").select("coins").eq("id", user.id).single();
          if (freshUser) {
            user.coins = freshUser.coins;
            localStorage.setItem("junstore_user", JSON.stringify(user));
            // Không thể sửa trực tiếp biến `currentUser` trong module script (khác
            // scope) nên cập nhật thẳng số Xu hiển thị trên header tại đây.
            const coinsEl = document.getElementById("userCoins");
            if (coinsEl) coinsEl.textContent = freshUser.coins;
          }
        }
      } catch (_) {}
    }
  }
  window.syncNapHistoryStatus = syncNapHistoryStatus;

  window.handleNapTheCao = async function (e) {
    e.preventDefault();
    const pinEl = document.getElementById("napPin");
    const seriEl = document.getElementById("napSeri");
    const pin = pinEl ? pinEl.value.trim() : "";
    const seri = seriEl ? seriEl.value.trim() : "";
    const btn = document.getElementById("napBtn");
    if (!pin || !seri) { alert("Vui lòng nhập đủ mã thẻ & seri."); return; }

    if (typeof window.selectedTelco === "undefined" || !window.selectedTelco) window.selectedTelco = "Viettel";
    if (typeof window.selectedDenom === "undefined" || !window.selectedDenom) window.selectedDenom = "50000";
    const telco = window.selectedTelco;
    const denom = String(window.selectedDenom);

    let user = null;
    try { user = JSON.parse(localStorage.getItem("junstore_user") || "null"); } catch (_) {}
    if (!user || !user.username) {
      alert("Vui lòng đăng nhập để nạp thẻ.");
      if (window.openLoginModal) window.openLoginModal();
      return;
    }
    if (user.status === "pending") {
      alert("Tài khoản bạn đang chờ duyệt. Vui lòng liên hệ Discord để được duyệt trước khi nạp.");
      return;
    }

    const xu = xuMap[denom] || 0;
    if (!xu) { alert("Mệnh giá không hợp lệ."); return; }

    const password = window.getStoredOrPromptPassword
      ? window.getStoredOrPromptPassword("Nhập lại mật khẩu để gửi thẻ nạp:")
      : prompt("Nhập lại mật khẩu để gửi thẻ nạp:");
    if (!password) return;

    const original = btn ? btn.innerHTML : "";
    if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Đang gửi yêu cầu...'; btn.style.opacity = ".9"; }

    let data;
    try {
      data = await window.callRechargeApi("submit", {
        username: user.username,
        password,
        telco,
        amount: parseInt(denom, 10),
        pin,
        serial: seri,
      });
    } catch (err) {
      console.error(err);
      data = { ok: false, error: "network_error" };
    }

    if (btn) { btn.disabled = false; btn.innerHTML = original; btn.style.opacity = "1"; }

    if (!data.ok) {
      const messages = {
        duplicate_card: "Thẻ này đã được gửi trước đó rồi (không thể gửi trùng thẻ).",
        invalid_card_data: "Sai định dạng mã thẻ/seri hoặc mệnh giá không hợp lệ.",
        invalid_credentials: "Mật khẩu không đúng.",
        not_approved: "Tài khoản chưa được duyệt.",
        banned: "Tài khoản đã bị khoá.",
        server_not_configured: "Hệ thống nạp thẻ chưa được cấu hình xong. Vui lòng liên hệ Discord.",
      };
      alert(messages[data.error] || ("Lỗi: " + (data.error || "không xác định") + " — thử lại hoặc liên hệ Discord."));
      return;
    }

    const now = new Date();
    const timeStr = now.toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" }) + " " + now.toLocaleDateString("vi-VN");
    const list = readHistory();
    list.unshift({
      id: data.request.id,
      requestCode: data.request.request_code,
      telco,
      menhgia: denom,
      xu,
      time: timeStr,
      status: "pending",
    });
    writeHistory(list);
    renderNapHistory();

    const toast = document.createElement("div");
    toast.style.cssText = "position:fixed;left:50%;top:18px;transform:translateX(-50%) translateY(-12px);background:var(--ink);color:#fff;padding:12px 16px;border-radius:999px;box-shadow:0 16px 40px -14px rgba(0,0,0,.3);display:flex;align-items:center;gap:10px;z-index:10001;opacity:0;transition:all .42s var(--ease);font-weight:700;font-size:.88rem;max-width:min(92%,420px);text-align:center";
    toast.innerHTML = '<span style="width:28px;height:28px;display:grid;place-items:center;border-radius:50%;background:var(--lime);color:#0f0f0f;flex-shrink:0"><i class="fa-solid fa-clock"></i></span> Đã gửi yêu cầu nạp ' + Number(denom).toLocaleString("vi-VN") + "đ → " + xu + " Xu. Mã: " + data.request.request_code + ". Đang chờ admin duyệt.";
    document.body.appendChild(toast);
    requestAnimationFrame(() => { toast.style.opacity = "1"; toast.style.transform = "translateX(-50%) translateY(0)"; });
    setTimeout(() => { toast.style.opacity = "0"; toast.style.transform = "translateX(-50%) translateY(-12px)"; setTimeout(() => toast.remove(), 400); }, 3800);

    if (pinEl) pinEl.value = "";
    if (seriEl) seriEl.value = "";
    if (typeof window.refreshHistoryView === "function") window.refreshHistoryView();
  };

  // ---------------------------------------------------------------------
  // ADMIN — Duyệt nạp (danh sách thật từ manage-recharge action "list",
  // duyệt/từ chối qua "approve"/"reject" — Xu được cộng ở server, atomic).
  // ---------------------------------------------------------------------
  function adminCreds() {
    let user = null;
    try { user = JSON.parse(localStorage.getItem("junstore_user") || "null"); } catch (_) {}
    if (!user || user.is_admin !== true) return null;
    const password = window.getStoredOrPromptPassword
      ? window.getStoredOrPromptPassword("Nhập lại mật khẩu Admin để tiếp tục:")
      : prompt("Nhập lại mật khẩu Admin để tiếp tục:");
    if (!password) return null;
    return { username: user.username, password };
  }

  window.refreshPendingNapCount = async function () {
    const badge = document.getElementById("pendingNapBadge");
    if (!badge) return;
    const creds = window._silentAdminCreds; // set lazily by refreshPendingNapList
    if (!creds) return;
    try {
      const data = await window.callRechargeApi("list", creds);
      const count = data && data.ok ? (data.requests || []).length : 0;
      if (count > 0) { badge.textContent = count; badge.style.display = "inline-flex"; }
      else badge.style.display = "none";
    } catch (_) {}
  };

  window.refreshPendingNapList = async function (opts) {
    const box = document.getElementById("pendingNapList");
    if (!box) return;
    const creds = adminCreds();
    if (!creds) { box.innerHTML = '<div class="empty-state" style="padding:1.5rem"><p>Cần đăng nhập bằng tài khoản Admin.</p></div>'; return; }
    window._silentAdminCreds = creds;

    box.innerHTML = '<div class="empty-state" style="padding:1.5rem"><p>Đang tải...</p></div>';
    let data;
    try { data = await window.callRechargeApi("list", creds); } catch (err) { console.error(err); data = { ok: false, error: "network_error" }; }

    if (!data.ok) {
      box.innerHTML = `<div class="empty-state" style="padding:1.5rem"><p>Lỗi tải danh sách: ${data.error || "không xác định"}</p></div>`;
      return;
    }

    const badge = document.getElementById("pendingNapBadge");
    const pending = data.requests || [];
    if (badge) {
      if (pending.length > 0) { badge.textContent = pending.length; badge.style.display = "inline-flex"; }
      else badge.style.display = "none";
    }

    if (pending.length === 0) {
      box.innerHTML = '<div class="empty-state" style="padding:1.5rem"><p>Chưa có yêu cầu nạp nào đang chờ.</p></div>';
      return;
    }

    box.innerHTML = pending.map((it) => `
      <div class="approval-row" style="align-items:flex-start">
        <div style="flex:1;min-width:0">
          <div class="approval-name" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap"><i class="fa-solid fa-user" style="color:var(--violet)"></i> ${it.username} <span style="font-family:var(--font-mono);font-size:.72rem;background:var(--paper2);border:1px solid var(--line);padding:2px 6px;border-radius:999px">${it.telco} ${Number(it.amount).toLocaleString("vi-VN")}đ → ${it.coins} Xu</span></div>
          <div class="approval-discord" style="flex-wrap:wrap;gap:8px;margin-top:6px">
            <span><i class="fa-solid fa-hashtag"></i> Mã: ${it.requestCode}</span>
            <span><i class="fa-solid fa-key"></i> PIN: <b style="font-family:var(--font-mono);letter-spacing:.04em">${it.pin}</b></span>
            <span><i class="fa-solid fa-barcode"></i> Seri: <b style="font-family:var(--font-mono)">${it.serial}</b></span>
            <span><i class="fa-solid fa-clock"></i> ${new Date(it.createdAt).toLocaleString("vi-VN")}</span>
          </div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;flex-shrink:0">
          <button class="btn btn-violet btn-sm" onclick="approveNap('${it.id}')"><i class="fa-solid fa-check"></i> Duyệt +${it.coins} Xu</button>
          <button class="btn btn-danger btn-sm" onclick="rejectNap('${it.id}')"><i class="fa-solid fa-xmark"></i> Từ chối</button>
        </div>
      </div>
    `).join("");
  };

  window.approveNap = async function (id) {
    if (!confirm("Duyệt nạp này? Xu sẽ cộng vào tài khoản user ngay lập tức.")) return;
    const creds = window._silentAdminCreds || adminCreds();
    if (!creds) return;
    let data;
    try { data = await window.callRechargeApi("approve", { ...creds, requestId: id }); } catch (err) { console.error(err); data = { ok: false, error: "network_error" }; }
    if (!data.ok) { alert("Lỗi duyệt: " + (data.error || "không xác định")); return; }
    const result = data.result || {};
    alert(`Đã duyệt! +${result.coinsAdded ?? "?"} Xu cho ${result.username ?? "user"}. Số dư mới: ${result.totalCoins ?? "?"} Xu.`);
    window.refreshPendingNapList();
  };

  window.rejectNap = async function (id) {
    const reason = prompt("Lý do từ chối (VD: sai mệnh giá, thẻ đã dùng...):", "Thẻ không hợp lệ");
    if (reason === null) return;
    const creds = window._silentAdminCreds || adminCreds();
    if (!creds) return;
    let data;
    try { data = await window.callRechargeApi("reject", { ...creds, requestId: id, reason }); } catch (err) { console.error(err); data = { ok: false, error: "network_error" }; }
    if (!data.ok) {
      if (data.error === "request_not_pending") alert("Yêu cầu này đã được xử lý trước đó rồi.");
      else alert("Lỗi từ chối: " + (data.error || "không xác định"));
      return;
    }
    window.refreshPendingNapList();
  };

  window.clearPendingNapHistory = function () {
    if (!confirm("Xoá lịch sử nạp hiển thị ở máy này? (không ảnh hưởng dữ liệu trên server)")) return;
    writeHistory([]);
    renderNapHistory();
  };

  // Chỉ hiện thông báo trình duyệt (Notification API) khi admin bật, không
  // giả vờ "đã bật" nếu người dùng từ chối quyền.
  window.enableRechargeNotifications = async function () {
    if (!("Notification" in window)) { alert("Trình duyệt này không hỗ trợ thông báo đẩy."); return; }
    const perm = await Notification.requestPermission();
    if (perm === "granted") alert("Đã bật thông báo trình duyệt cho yêu cầu nạp mới.");
    else alert("Bạn chưa cho phép thông báo. Vào cài đặt trình duyệt để bật lại.");
  };

  // Khởi động: vẽ lịch sử hiện có + đồng bộ trạng thái với server.
  document.addEventListener("DOMContentLoaded", () => {
    renderNapHistory();
    setTimeout(syncNapHistoryStatus, 1200);
    setInterval(syncNapHistoryStatus, 45000);
  });
  if (document.readyState !== "loading") {
    renderNapHistory();
    setTimeout(syncNapHistoryStatus, 1200);
    setInterval(syncNapHistoryStatus, 45000);
  }
})();
