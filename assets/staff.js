(function () {
  const B = window.BHL, api = B.api, cfg = B.cfg;
  const $ = (id) => document.getElementById(id);
  const LOCAL_TZ = cfg.LOCAL_TZ || "Asia/Manila";
  let roster = null, me = null, pin = "", entry = "", pinMode = "enter", firstPin = "", data = null, armedOut = false, idleT;

  const tz = () => roster?.settings?.timezone || "Europe/London";
  const show = (v) => { for (const id of ["vPick", "vPin", "vToday"]) $(id).hidden = id !== v; document.querySelector("main").classList.toggle("wide", v === "vPick"); window.scrollTo(0, 0); };

  // ---------- clocks ----------
  function tick() {
    const now = new Date();
    $("ukClock").textContent = B.clockIn(now, tz());
    $("ukLabel").textContent = B.tzShort(tz(), now) === "BST" || B.tzShort(tz(), now) === "GMT" ? "UK" : B.tzShort(tz(), now);
    $("phClock").textContent = B.clockIn(now, LOCAL_TZ);
    $("phLabel").textContent = cfg.LOCAL_LABEL || "Local";
  }

  // ---------- roster / pick ----------
  function statusOf(t) {
    if (!t || !t.time_in) return ["absent", "Not in yet"];
    if (t.time_out) return ["out", "Clocked out"];
    if (t.lunch_out && !t.lunch_in) return ["lunch", "On lunch"];
    return ["in", "Working"];
  }
  async function loadRoster() {
    try { roster = await api.roster(); }
    catch (e) { B.toast("Can't reach the server. Check your connection.", "err"); return; }
    tick();
    $("pickDate").textContent = B.prettyDate(roster.today, { weekday: "long", day: "numeric", month: "long" });
    $("people").innerHTML = roster.staff.map((s) => {
      const [k, label] = statusOf(s.today);
      const g = B.stats(s.recent, s, roster.settings, roster.today);
      return `<button class="person" data-id="${B.esc(s.id)}" style="--card-tint:${B.colorOf(s)}">
        <span class="top">${B.avatarHtml(s, 46)}<span><span class="nm">${B.esc(s.display_name)}</span>${streakChip(g.streak)}</span></span>
        <span class="tagline">${B.esc(s.tagline || "")}</span>
        <span class="pill ${k}">${label}</span>
        <span class="sub">${B.clockStr(s.today?.sched_start || s.sched_start)}–${B.clockStr(s.today?.sched_end || s.sched_end)}</span>
      </button>`;
    }).join("") || `<p class="muted">No staff yet. An admin can add people from the admin page.</p>`;
    renderTeam();
  }
  function streakChip(n) {
    return n >= 2 ? `<span class="chip-streak" title="${n} on-time days in a row">${B.icon("flame", 13)}${n} on-time</span>` : "";
  }
  function renderTeam() {
    if (!roster) return;
    $("team").innerHTML = roster.staff.map((s) => {
      const [k, label] = statusOf(s.today);
      const t = s.today;
      const times = t?.time_in ? `in ${B.clockIn(new Date(t.time_in), tz())}${t.time_out ? " · out " + B.clockIn(new Date(t.time_out), tz()) : ""}` : "";
      return `<div class="tr">${B.avatarHtml(s, 30)}<span class="n">${B.esc(s.display_name)}</span><span class="pill ${k}">${label}</span><span class="x">${times}</span></div>`;
    }).join("");
  }
  $("people").addEventListener("click", (e) => {
    const b = e.target.closest(".person"); if (!b) return;
    pick(roster.staff.find((s) => s.id === b.dataset.id));
  });

  // ---------- PIN ----------
  function pick(s) {
    me = s; entry = ""; firstPin = "";
    pinMode = s.has_pin ? "enter" : "create1";
    B.lsSet("bhl.me", s.id);
    renderPin(); show("vPin");
  }
  function renderPin(hint) {
    $("pinTitle").textContent = me.display_name;
    $("pinAv").innerHTML = B.avatarHtml(me, 64);
    $("pinEyebrow").textContent = pinMode === "enter" ? "Enter your PIN" : pinMode === "create1" ? "Create a 4-digit PIN" : "Type it again";
    $("pinHint").textContent = hint || (pinMode === "enter" ? "" : "You'll use this every time you clock in.");
    [...$("dots").children].forEach((d, i) => d.classList.toggle("on", i < entry.length));
  }
  $("pad").innerHTML = [1, 2, 3, 4, 5, 6, 7, 8, 9, "", 0, "⌫"].map((k) =>
    k === "" ? `<button class="blank" tabindex="-1" aria-hidden="true"></button>` :
    `<button data-k="${k}" aria-label="${k === "⌫" ? "Delete" : k}">${k}</button>`).join("");
  $("pad").addEventListener("click", (e) => { const b = e.target.closest("button[data-k]"); if (b) key(b.dataset.k); });
  document.addEventListener("keydown", (e) => {
    if ($("vPin").hidden) return;
    if (/^\d$/.test(e.key)) key(e.key); else if (e.key === "Backspace") key("⌫");
  });
  function fail(msg) {
    entry = ""; renderPin(msg);
    $("dots").classList.remove("shake"); void $("dots").offsetWidth; $("dots").classList.add("shake");
  }
  async function key(k) {
    if (k === "⌫") { entry = entry.slice(0, -1); return renderPin(); }
    if (entry.length >= 4) return;
    entry += k; renderPin();
    if (entry.length < 4) return;
    const typed = entry;
    if (pinMode === "create1") { firstPin = typed; pinMode = "create2"; entry = ""; return renderPin(); }
    if (pinMode === "create2") {
      if (typed !== firstPin) { pinMode = "create1"; return fail("Those didn't match. Start again."); }
      const r = await api.setPin(me.id, null, typed).catch((e) => ({ ok: false, error: e.message }));
      if (!r.ok) { pinMode = me.has_pin ? "enter" : "create1"; return fail(r.error); }
      me.has_pin = true; B.toast("PIN saved");
    }
    const r = await api.punch(me.id, typed, "check").catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) return fail(r.error);
    pin = typed; data = r; renderToday(); show("vToday"); bumpIdle();
  }
  $("pinBack").onclick = () => { B.lsSet("bhl.me", null); me = null; show("vPick"); };

  // ---------- today ----------
  const todayRow = () => data.rows.find((r) => r.work_date === B.dateIn(new Date(data.now), tz())) || null;
  function renderToday() {
    const row = todayRow(), st = data.staff, set = data.settings;
    const today = B.dateIn(new Date(), set.timezone);
    $("tDate").textContent = B.prettyDate(today, { weekday: "long", day: "numeric", month: "long" });
    $("tName").textContent = `Hi, ${st.display_name}`;
    $("meAv").innerHTML = B.avatarHtml(st, 58);
    $("tTag").textContent = st.tagline || "";
    renderSeason();
    const [k, label] = statusOf(row);
    $("tStatus").className = "pill " + k; $("tStatus").textContent = label;
    const plan = row ? null : todayPlan(st);
    const ss = row?.sched_start || (plan?.kind === "shift" ? plan.start + ":00" : st.sched_start), se = row?.sched_end || (plan?.kind === "shift" ? plan.end + ":00" : st.sched_end);
    $("tSched").textContent = plan && plan.kind !== "shift" ? `${B.sched.KINDS[plan.kind].label} today` : `${B.clockStr(ss)} – ${B.clockStr(se)} UK`;
    $("schedEdit").hidden = !!row?.time_in;
    if (!row?.time_in) { $("sStart").value ||= ss.slice(0, 5); $("sEnd").value ||= se.slice(0, 5); }
    if (document.activeElement !== $("tNote")) $("tNote").value = row?.note || "";

    const c = row ? B.calcDay(row, st, set) : null;
    const flags = [];
    if (c?.late) flags.push(`<span class="flag late">Late ${B.fmtMins(c.late)}</span>`);
    if (c?.complete && c.ot) flags.push(`<span class="flag ot">OT +${B.fmtMins(c.ot)}</span>`);
    if (c?.complete && c.short) flags.push(`<span class="flag short">Short ${B.fmtMins(c.short)}</span>`);
    $("tFlags").innerHTML = flags.join("");

    // actions
    const main = $("actMain"), alt = $("actAlt");
    main.hidden = false; main.disabled = false; main.className = "btn primary big"; alt.innerHTML = ""; armedOut = false;
    if (!row?.time_in) { main.textContent = "Clock in"; main.dataset.a = "in"; }
    else if (row.time_out) { main.hidden = true; alt.innerHTML = `<p style="margin:0">You clocked out at <b class="mono">${B.clockIn(new Date(row.time_out), set.timezone)}</b>. See you tomorrow.</p>`; }
    else if (row.lunch_out && !row.lunch_in) { main.textContent = "End lunch"; main.dataset.a = "lunch_end"; main.classList.add("lunch"); }
    else if (!row.lunch_out) {
      main.textContent = "Start lunch"; main.dataset.a = "lunch_start"; main.classList.add("lunch");
      alt.innerHTML = `<button class="btn" data-a="out">Clock out</button><button class="btn ghost" data-a="note">Save note</button>`;
    } else {
      main.textContent = "Clock out"; main.dataset.a = "out"; main.classList.add("out");
      alt.innerHTML = `<button class="btn ghost" data-a="note">Save note</button>`;
    }

    // timeline
    const tl = [["Time in", row?.time_in], ["Lunch out", row?.lunch_out], ["Lunch in", row?.lunch_in], ["Time out", row?.time_out]];
    $("timeline").innerHTML = tl.map(([k, v]) => `<div><span class="k">${k}</span>
      <span class="v ${v ? "" : "empty"}">${v ? B.clockIn(new Date(v), set.timezone) : "--:--"}</span>
      <span class="l">${v ? B.clockIn(new Date(v), LOCAL_TZ) + " " + (cfg.LOCAL_LABEL || "") : "&nbsp;"}</span></div>`).join("");

    // month
    const month = today.slice(0, 7);
    const sum = B.summarise(data.rows.filter((r) => r.work_date.startsWith(month)), st, set, today);
    $("mLabel").textContent = B.prettyDate(month + "-01", { month: "long", year: "numeric" });
    $("mDays").textContent = sum.days;
    $("mHours").textContent = B.fmtMins(sum.worked);
    $("mBank").textContent = B.fmtMins(sum.bank, { sign: true });
    $("mBank").style.color = sum.bank < 0 ? "var(--late)" : sum.bank > 0 ? "var(--accent)" : "";
    $("mBlock").textContent = set.ot_block_mins;
    renderTeam();
  }

  async function act(a, btn) {
    const row = todayRow();
    if (a === "out" && !armedOut) {
      const end = B.zonedToDate(row.work_date, row.sched_end, data.settings.timezone);
      if (new Date() < end) {
        armedOut = true; btn.textContent = `Before ${B.clockStr(row.sched_end)}: tap again to clock out`; return;
      }
    }
    const extra = { note: $("tNote").value };
    if (a === "in" && $("schedEdit").open) { extra.sched_start = $("sStart").value; extra.sched_end = $("sEnd").value; }
    btn.disabled = true;
    const r = await api.punch(me.id, pin, a, extra).catch((e) => ({ ok: false, error: e.message }));
    btn.disabled = false;
    if (!r.ok) { B.toast(r.error, "err"); if (/PIN/.test(r.error)) { pin = ""; pick(me); } return; }
    const before = game();
    data = r;
    const after = game();
    const words = { in: "Clocked in", lunch_start: "Enjoy your lunch", lunch_end: "Welcome back", out: "Clocked out", note: "Note saved" };
    const gained = after.xp - before.xp;
    const newBadges = after.badges.filter((b, i) => b.earned && !before.badges[i].earned);
    let msg = `${words[a]} · ${B.clockIn(new Date(r.now), r.settings.timezone)} UK`;
    if (gained > 0) msg += ` · +${gained} XP`;
    if (a === "in" && after.streak >= 2) msg += ` · ${after.streak}-day streak`;
    if (newBadges.length) msg = `Badge unlocked: ${newBadges.map((b) => b.name).join(", ")}! ` + (gained > 0 ? `+${gained} XP` : "");
    B.toast(msg);
    fresh = new Set(newBadges.map((b) => b.key));
    const onTimeIn = a === "in" && !B.calcDay(todayRow(), data.staff, data.settings).late;
    if (newBadges.length || onTimeIn || after.level.n > before.level.n) B.confetti();
    renderToday(); loadRoster(); bumpIdle();
  }
  $("actMain").onclick = (e) => act(e.currentTarget.dataset.a, e.currentTarget);
  $("actAlt").addEventListener("click", (e) => { const b = e.target.closest("button[data-a]"); if (b) act(b.dataset.a, b); });


  // ---------- season (XP, level, streak, badges) ----------
  let fresh = new Set();
  const game = () => B.stats(data.rows, data.staff, data.settings, B.dateIn(new Date(data.now), data.settings.timezone));
  function renderSeason() {
    const g = game(), L = g.level;
    $("tLevel").textContent = `Level ${L.n} · ${L.title}`;
    $("lvlRing").style.setProperty("--p", L.pct);
    $("lvlRing").innerHTML = `<div><b>${L.n}</b><small>Level</small></div>`;
    $("xpNow").textContent = `${g.xp} XP`;
    $("xpNext").textContent = L.next ? `${L.next - g.xp} XP to Level ${L.n + 1}` : "Top level reached";
    requestAnimationFrame(() => { $("xpFill").style.width = L.pct + "%"; });
    $("streakNow").innerHTML = `${B.icon("flame", 16)} ${g.streak}-day on-time streak`;
    $("streakBest").textContent = g.best > g.streak ? `Best: ${g.best}` : g.streak ? "Personal best!" : "Clock in on time to start one";
    const colors = { first: "#56606b", early: "#e0912b", fire: "#d9622b", iron: "#1f6fb2", week: "#0d7656", lunch: "#b07d0c", tidy: "#6d4bc4", ot: "#c2416b" };
    $("badges").innerHTML = g.badges.map((b) => `<div class="badge ${b.earned ? "" : "locked"} ${fresh.has(b.key) ? "fresh" : ""}" title="${B.esc(b.desc)}" style="--bc:${colors[b.key]}">
      <span class="ic">${B.icon(b.icon, 20)}</span><b>${B.esc(b.name)}</b>
      <small>${b.earned ? "Unlocked" : b.goal > 1 ? `${b.key === "ot" ? B.fmtMins(b.have) + " / 2:00" : b.have + " / " + b.goal}` : B.esc(b.desc)}</small></div>`).join("");
    fresh = new Set();
  }

  // ---------- profile editor ----------
  let draft = null;
  function openProfile() {
    const st = data.staff;
    draft = { avatar: st.avatar || (st.photo ? null : "sunrise"), photo: st.photo || null, tagline: st.tagline || "", color: st.color || "jade" };
    $("tagIn").value = draft.tagline;
    renderProfile(); $("profDlg").showModal();
  }
  function renderProfile() {
    const view = { ...data.staff, ...draft, tagline: $("tagIn").value };
    $("profPreview").innerHTML = `${B.avatarHtml(view, 64)}<div><b style="font-family:var(--display);font-size:20px">${B.esc(view.display_name)}</b>
      <div class="muted" style="font-size:13px;font-style:italic">${B.esc(view.tagline || "Add a tagline below")}</div></div>`;
    $("avGrid").innerHTML = B.AVATARS.map((k) => `<button type="button" role="radio" aria-checked="${!draft.photo && draft.avatar === k}" aria-label="${k} avatar" data-av="${k}">${B.avatarSvg(k, 48)}</button>`).join("");
    $("swatches").innerHTML = Object.entries(B.COLORS).map(([k, c]) => `<button type="button" role="radio" aria-checked="${draft.color === k}" aria-label="${k}" data-c="${k}" style="--sw:${c}"></button>`).join("");
    $("photoRm").hidden = !draft.photo;
  }
  $("avGrid").addEventListener("click", (e) => { const b = e.target.closest("[data-av]"); if (!b) return; draft.avatar = b.dataset.av; draft.photo = null; renderProfile(); });
  $("swatches").addEventListener("click", (e) => { const b = e.target.closest("[data-c]"); if (!b) return; draft.color = b.dataset.c; renderProfile(); });
  $("tagIn").addEventListener("input", () => renderProfile());
  $("photoIn").addEventListener("change", async (e) => {
    try { draft.photo = await B.resizePhoto(e.target.files[0]); renderProfile(); }
    catch (err) { B.toast(err.message, "err"); }
    e.target.value = "";
  });
  $("photoRm").onclick = () => { draft.photo = null; draft.avatar ||= "sunrise"; renderProfile(); };
  $("profForm").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const p = { ...draft, tagline: $("tagIn").value.trim() };
    $("profSave").disabled = true;
    const r = await api.setProfile(me.id, pin, p).catch((err) => ({ ok: false, error: err.message }));
    $("profSave").disabled = false;
    if (!r.ok) return B.toast(r.error, "err");
    Object.assign(data.staff, p); Object.assign(me, p);
    $("profDlg").close(); B.toast("Profile saved"); renderToday(); loadRoster();
  });
  $("meAv").onclick = openProfile;
  $("editProfile").onclick = openProfile;
  // ---------- weekly schedule ----------
  (function () { const st = document.createElement("style"); st.textContent = B.sched.CSS; document.head.appendChild(st); })();
  let wkFrom = null, wkView = "table", wkData = null, thisWeek = null;
  try { wkView = localStorage.getItem("bhl.wkView") || "table"; } catch {}
  async function loadWeek(from) {
    const S = B.sched, today = roster ? roster.today : B.dateIn(new Date(), tz());
    wkFrom = from || S.weekStart(today);
    try { wkData = await api.weekSchedule(wkFrom); } catch { return; }
    if (wkFrom === S.weekStart(today)) thisWeek = wkData;
    const ov = S.indexDays(wkData.staff.flatMap((p) => p.days.map((d) => ({ ...d, staff_id: p.id }))));
    const end = S.addDays(wkFrom, 6);
    const endTxt = B.prettyDate(end, { day: "numeric", month: "long", year: "numeric" });
    $("weekTitle").textContent = wkFrom.slice(5, 7) === end.slice(5, 7) ? `${+wkFrom.slice(8)} – ${endTxt}` : `${B.prettyDate(wkFrom, { day: "numeric", month: "long" })} – ${endTxt}`;
    $("weekView").innerHTML = wkView === "table" ? S.tableHtml(wkFrom, wkData.staff, ov, today) : S.timelineHtml(wkFrom, wkData.staff, ov, today);
    $("wkTable").setAttribute("aria-pressed", wkView === "table"); $("wkTime").setAttribute("aria-pressed", wkView !== "table");
    $("weekBox").hidden = !wkData.staff.length;
  }
  $("wkPrev").onclick = () => loadWeek(B.sched.addDays(wkFrom, -7));
  $("wkNext").onclick = () => loadWeek(B.sched.addDays(wkFrom, 7));
  $("wkNow").onclick = () => loadWeek(null);
  const setView = (v) => { wkView = v; try { localStorage.setItem("bhl.wkView", v); } catch {} loadWeek(wkFrom); };
  $("wkTable").onclick = () => setView("table"); $("wkTime").onclick = () => setView("time");
  /** Today's plan for a person from this week's schedule (falls back to their usual hours). */
  function todayPlan(st) {
    const p = thisWeek?.staff.find((x) => x.id === st.id); if (!p) return null;
    const ov = B.sched.indexDays(p.days.map((d) => ({ ...d, staff_id: p.id })));
    return B.sched.effective(p, B.dateIn(new Date(), tz()), ov);
  }

  // ---------- my payslips ----------
  (function () { const st = document.createElement("style"); st.textContent = B.payroll.SLIP_CSS + " #slipDlg .slip{margin:0 auto}"; document.head.appendChild(st); })();
  let mySlips = [], myCompany = "";
  $("mySlips").onclick = async () => {
    $("mySlipView").innerHTML = `<p class="muted">Loading…</p>`; $("mySlipPick").hidden = $("mySlipActions").hidden = true; $("slipDlg").showModal();
    const r = await api.myPayslips(me.id, pin).catch((e) => ({ ok: false, error: e.message }));
    if (!r.ok) { $("mySlipView").innerHTML = `<p class="muted">${B.esc(r.error)}</p>`; return; }
    mySlips = r.payslips || []; myCompany = r.company;
    if (!mySlips.length) { $("mySlipView").innerHTML = `<p class="muted">No payslips yet. They appear here once payroll for a period is finalised.</p>`; return; }
    $("mySlipSel").innerHTML = mySlips.map((x, i) => `<option value="${i}">${B.payroll.period({ start_date: x.period_start, end_date: x.period_end })} · paid ${B.prettyDate(x.pay_date)}</option>`).join("");
    $("mySlipPick").hidden = $("mySlipActions").hidden = false; showMySlip();
  };
  function showMySlip() { $("mySlipView").innerHTML = B.payroll.slipHtml(mySlips[+$("mySlipSel").value], myCompany); }
  $("mySlipSel").onchange = showMySlip;
  $("mySlipPdf").onclick = () => {
    if (!window.jspdf?.jsPDF) return B.toast("Couldn't load the PDF tool. Check your connection and try again.", "err");
    const x = mySlips[+$("mySlipSel").value], doc = new window.jspdf.jsPDF({ unit: "pt", format: "a4" });
    B.payroll.slipPdf(doc, x, myCompany, true); doc.save(`Payslip_${x.period_start}_to_${x.period_end}.pdf`);
  };

  $("copyWa").onclick = async () => {
    const row = todayRow();
    if (!row) return B.toast("Clock in first, then copy.", "err");
    const ok = await B.copyText(B.whatsappText(row, data.staff, data.settings));
    B.toast(ok ? "Copied. Paste it in the WhatsApp group." : "Couldn't copy on this device.", ok ? "ok" : "err");
  };
  function lock() { pin = ""; data = null; if (me) pick(me); else show("vPick"); }
  $("switchUser").onclick = () => { pin = ""; data = null; B.lsSet("bhl.me", null); me = null; show("vPick"); loadRoster(); };
  function bumpIdle() { clearTimeout(idleT); idleT = setTimeout(() => { if (!$("vToday").hidden) lock(); }, 5 * 60 * 1000); }
  ["click", "keydown", "touchstart"].forEach((ev) => document.addEventListener(ev, () => pin && bumpIdle(), { passive: true }));

  // Logo and "Staff" link = back to the homepage (who's clocking in), signed out
  document.querySelectorAll('a.brand, .sitenav a[aria-current="page"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault(); pin = ""; data = null; me = null; B.lsSet("bhl.me", null); show("vPick"); loadRoster(); loadWeek(null);
  }));

  // ---------- boot ----------
  (async () => {
    if (!api.ready) return;
    tick(); setInterval(tick, 10000);
    await loadRoster();
    loadWeek(null);
    const saved = B.lsGet("bhl.me");
    const s = roster?.staff.find((x) => x.id === saved);
    if (s) pick(s); else show("vPick");
    setInterval(() => { if (!document.hidden) loadRoster(); }, 60000);
  })();
})();
