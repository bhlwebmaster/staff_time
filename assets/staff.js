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
      const plan = !s.today?.time_in ? todayPlan(s) : null, off = plan && plan.kind !== "shift";
      return `<button class="person" data-id="${B.esc(s.id)}" style="--card-tint:${B.colorOf(s)}">
        <span class="top">${B.avatarHtml(s, 46)}<span><span class="nm">${B.esc(s.display_name)}</span>${streakChip(g.streak)}</span></span>
        <span class="tagline">${B.esc(s.tagline || "")}</span>
        ${off ? liveStatus(s, plan) : `<span class="pill ${k}">${label}</span>`}
        <span class="sub">${off ? "&nbsp;" : plan ? `${B.clockStr(plan.start)}–${B.clockStr(plan.end)}` : `${B.clockStr(s.today?.sched_start || s.sched_start)}–${B.clockStr(s.today?.sched_end || s.sched_end)}`}</span>
      </button>`;
    }).join("") || `<p class="muted">No staff yet. An admin can add people from the admin page.</p>`;
    renderTeam();
    if (wkData && wkRange === "day" && wkAt === roster.today && !$("vPick").hidden) loadWeek(wkAt);
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
    pin = typed; data = r; $("waHint").hidden = true; $("waNotify").classList.remove("nudge");
    renderToday(); show("vToday"); bumpIdle();
    msIdx = 0; msEditing = false; msReqs = []; loadMySched(true);
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
    renderWa();
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
    // Only the start and end of the shift go to the group (not lunch)
    if (a === "in" || a === "out") {
      $("waHintTitle").textContent = a === "in" ? "Tell the group you're in" : "Tell the group you've clocked out";
      $("waHint").hidden = false;
      const w = $("waNotify"); w.classList.remove("nudge"); void w.offsetWidth; w.classList.add("nudge");
      w.scrollIntoView({ block: "center", behavior: "smooth" });
    }
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
  // Range: "day" (default, opens on today) or "week". wkAt = the day shown, or any day in the week shown.
  let wkFrom = null, wkView = "table", wkData = null, thisWeek = null, wkRange = "day", wkAt = null;
  const wkCache = {};
  try { wkView = localStorage.getItem("bhl.wkView") || "table"; } catch {}
  const schedToday = () => roster ? roster.today : B.dateIn(new Date(), tz());
  async function loadWeek(at) {
    const S = B.sched, today = schedToday();
    if (!at) delete wkCache[S.weekStart(today)]; // "Today" / "This week" / reload always fetch fresh
    wkAt = at || today;
    wkFrom = S.weekStart(wkAt);
    try { wkData = wkCache[wkFrom] || (wkCache[wkFrom] = await api.weekSchedule(wkFrom)); } catch { return; }
    if (wkFrom === S.weekStart(today)) { const first = !thisWeek; thisWeek = wkData; if (first && roster) loadRoster(); }
    const ov = S.indexDays(wkData.staff.flatMap((p) => p.days.map((d) => ({ ...d, staff_id: p.id }))));
    const day = wkRange === "day";
    if (day) {
      const rel = wkAt === today ? "Today · " : wkAt === S.addDays(today, 1) ? "Tomorrow · " : wkAt === S.addDays(today, -1) ? "Yesterday · " : "";
      $("weekTitle").textContent = rel + B.prettyDate(wkAt, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    } else {
      const end = S.addDays(wkFrom, 6);
      const endTxt = B.prettyDate(end, { day: "numeric", month: "long", year: "numeric" });
      $("weekTitle").textContent = wkFrom.slice(5, 7) === end.slice(5, 7) ? `${+wkFrom.slice(8)} – ${endTxt}` : `${B.prettyDate(wkFrom, { day: "numeric", month: "long" })} – ${endTxt}`;
    }
    const from = day ? wkAt : wkFrom, opts = { n: day ? 1 : 7, colorFrom: wkFrom };
    if (day && wkAt === today && roster) opts.status = liveStatus;
    $("weekView").innerHTML = wkView === "table" ? S.tableHtml(from, wkData.staff, ov, today, opts) : S.timelineHtml(from, wkData.staff, ov, today, opts);
    $("wkTable").setAttribute("aria-pressed", wkView === "table"); $("wkTime").setAttribute("aria-pressed", wkView !== "table");
    $("wkDay").setAttribute("aria-pressed", day); $("wkWeek").setAttribute("aria-pressed", !day);
    $("wkPrev").setAttribute("aria-label", day ? "Previous day" : "Previous week"); $("wkNext").setAttribute("aria-label", day ? "Next day" : "Next week");
    $("weekBox").hidden = !wkData.staff.length;
  }
  /** Live status for today's table: leave/rest from the schedule, otherwise what they've tapped today. */
  function liveStatus(p, plan) {
    const r = roster.staff.find((x) => x.id === p.id), t = r?.today;
    if (!t?.time_in && plan.kind !== "shift") {
      const k = { rest: "Rest day", vacation: "Vacation", sick: "Sick", emergency: "Emergency leave", holiday: "Holiday", unpaid: "Unpaid leave" }[plan.kind] || plan.kind;
      return `<span class="pill leave k-${plan.kind}">${k}</span>`;
    }
    const tzn = tz(), now = new Date();
    if (!t?.time_in) {
      if (plan.start) {
        const st = B.zonedToDate(roster.today, plan.start, tzn), en = B.zonedToDate(roster.today, plan.end, tzn);
        const grace = (roster.settings?.grace_mins ?? 5) * 60000;
        if (en > st && now > en) return `<span class="pill late">Absent</span>`;
        if (now > new Date(st.getTime() + grace)) return `<span class="pill late">Late · not in</span>`;
      }
      return `<span class="pill absent">Not in yet</span>`;
    }
    const at = (v) => B.clockIn(new Date(v), tzn);
    if (t.time_out) return `<span class="pill out">Clocked out</span><small>${at(t.time_in)}–${at(t.time_out)}</small>`;
    if (t.lunch_out && !t.lunch_in) return `<span class="pill lunch">On lunch</span><small>since ${at(t.lunch_out)}</small>`;
    return `<span class="pill in">Working</span><small>in ${at(t.time_in)}</small>`;
  }
  const step = (dir) => loadWeek(B.sched.addDays(wkAt, dir * (wkRange === "day" ? 1 : 7)));
  $("wkPrev").onclick = () => step(-1);
  $("wkNext").onclick = () => step(1);
  // Tapping Today / This week always jumps back to the current day / week
  $("wkDay").onclick = () => { wkRange = "day"; loadWeek(null); };
  $("wkWeek").onclick = () => { wkRange = "week"; loadWeek(null); };
  const setView = (v) => { wkView = v; try { localStorage.setItem("bhl.wkView", v); } catch {} loadWeek(wkAt); };
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

  // ---------- WhatsApp group ----------
  // Copies the message in the group's format; the person pastes it into the WhatsApp group themselves.
  const waText = () => { const row = data && todayRow(); return row?.time_in ? B.whatsappText(row, data.staff, data.settings) : ""; };
  function renderWa() { $("waNotify").setAttribute("aria-disabled", String(!waText())); }
  $("waNotify").addEventListener("click", async () => {
    const t = waText();
    if (!t) return B.toast("Clock in first, then copy your message.", "err");
    const ok = await B.copyText(t);
    if (!ok) return B.toast("Couldn't copy on this device. Try again.", "err");
    B.toast("Copied! Now paste it in the BHL Attendance WhatsApp group.");
    $("waHint").hidden = true; $("waNotify").classList.remove("nudge");
    $("waLabel").textContent = "Copied ✓"; setTimeout(() => { $("waLabel").textContent = "Copy & Send to WhatsApp Group"; }, 2500);
  });

  // ---------- my schedule (this week + next 2) and change requests ----------
  let msIdx = 0, msReqs = [], msEditing = false, msWk = null, msFrom = null;
  const MS_KINDS = ["shift", "rest", "vacation", "sick", "emergency", "unpaid"];
  const sameDay = (a, b) => a.kind === b.kind && (a.kind !== "shift" || (a.start === b.start && a.end === b.end));
  async function loadMySched(refresh) {
    if (!me || !pin) return;
    const S = B.sched, today = B.dateIn(new Date(), tz()), w0 = S.weekStart(today);
    const weeks = [0, 1, 2].map((i) => S.addDays(w0, 7 * i));
    $("msWeeks").innerHTML = weeks.map((w, i) => `<button type="button" data-i="${i}" aria-pressed="${i === msIdx}">${i === 0 ? "This week" : i === 1 ? "Next week" : "Week of " + B.prettyDate(w, { day: "numeric", month: "short" })}</button>`).join("");
    msFrom = weeks[msIdx];
    if (refresh) delete wkCache[msFrom];
    try { msWk = wkCache[msFrom] || (wkCache[msFrom] = await api.weekSchedule(msFrom)); }
    catch { $("msBody").innerHTML = `<p class="muted" style="margin:0">Couldn't load your schedule. Check your connection.</p>`; return; }
    if (msFrom === w0) thisWeek = msWk;
    if (refresh) { const r = await api.myScheduleRequests(me.id, pin).catch((e) => ({ ok: false, error: e.message })); if (r.ok) msReqs = r.requests || []; }
    renderMySched();
  }
  function renderMySched() {
    const S = B.sched, today = B.dateIn(new Date(), tz()), from = msFrom;
    const p = msWk?.staff.find((x) => x.id === me.id);
    if (!p) { $("msBody").innerHTML = `<p class="muted" style="margin:0">Your schedule isn't set up yet. Ask an admin.</p>`; return; }
    const ov = S.indexDays(p.days.map((d) => ({ ...d, staff_id: p.id })));
    const days = Array.from({ length: 7 }, (_, i) => S.addDays(from, i));
    const reqs = msReqs.filter((r) => r.week_start === from);
    const pending = reqs.find((r) => r.status === "pending");
    const latest = reqs.find((r) => r.status !== "cancelled");
    const reqDay = (d) => { const v = pending?.days?.[d]; return v ? { kind: v.kind, start: v.s, end: v.e } : null; };
    const label = (e) => S.KINDS[e.kind]?.label || e.kind;
    const fmt = (e) => e.kind === "shift" ? `${S.ampm(e.start)} – ${S.ampm(e.end)}` : `<span class="k ${S.KINDS[e.kind]?.cls || ""}">${label(e)}</span>`;
    const plain = (e) => e.kind === "shift" ? `${S.ampm(e.start)}–${S.ampm(e.end)}` : label(e);
    const dayLbl = (d) => `<span class="d">${S.DAY[S.dow(d)].slice(0, 3)[0] + S.DAY[S.dow(d)].slice(1, 3).toLowerCase()} ${+d.slice(8)}${d === today ? "<small>Today</small>" : ""}</span>`;
    const canEdit = days.some((d) => d >= today);
    let html = "";
    if (!msEditing) {
      if (pending) html += `<div class="ms-state pending"><b>Waiting for admin approval.</b> Sent ${B.prettyDate(B.dateIn(new Date(pending.created_at), tz()))}. Your changes are shown in orange.${pending.note ? `<br>Your note: <i>${B.esc(pending.note)}</i>` : ""}</div>`;
      else if (latest?.status === "rejected") html += `<div class="ms-state rejected"><b>Your change wasn't approved.</b>${latest.admin_note ? " " + B.esc(latest.admin_note) : ""} The schedule below is what's planned.</div>`;
      else if (latest?.status === "approved") html += `<div class="ms-state approved"><b>Approved.</b> Your requested changes are now in the schedule.</div>`;
      html += `<div class="ms-list">${days.map((d) => {
        const cur = S.effective(p, d, ov), req = reqDay(d), chg = req && !sameDay(req, cur);
        return `<div class="ms-row ${d === today ? "today" : ""} ${d < today ? "past" : ""} ${chg ? "chg" : ""}">${dayLbl(d)}
          <span class="v">${chg ? `<span class="old">${plain(cur)}</span><span class="arrow">→</span>${fmt(req)}` : fmt(cur)}</span></div>`;
      }).join("")}</div>`;
      html += `<div class="row" style="gap:8px">${canEdit ? `<button type="button" class="btn" data-ms="edit">${pending ? "Edit my request" : "Request a change"}</button>` : ""}
        ${pending ? `<button type="button" class="btn ghost" data-ms="withdraw">Withdraw request</button>` : ""}</div>
        <p class="muted" style="margin:0;font-size:12.5px">Changes go to an admin for approval. When an admin updates the schedule, you'll see it here straight away.</p>`;
    } else {
      html += `<div class="ms-list">${days.map((d) => {
        const cur = S.effective(p, d, ov), v = reqDay(d) || cur;
        if (d < today) return `<div class="ms-row past">${dayLbl(d)}<span class="v">${fmt(cur)}</span></div>`;
        return `<div class="ms-row" data-d="${d}">${dayLbl(d)}<span class="ed">
          <select aria-label="Day type">${MS_KINDS.map((k) => `<option value="${k}" ${v.kind === k ? "selected" : ""}>${k === "shift" ? "Working" : S.KINDS[k].label}</option>`).join("")}</select>
          <input type="time" aria-label="Start" value="${v.start || cur.start || S.hhmm(p.sched_start)}" ${v.kind === "shift" ? "" : "hidden"}>
          <input type="time" aria-label="End" value="${v.end || cur.end || S.hhmm(p.sched_end)}" ${v.kind === "shift" ? "" : "hidden"}></span></div>`;
      }).join("")}</div>
      <label class="f">Note for the admin <span class="muted" style="font-weight:400">e.g. "Swapping Monday and Wednesday"</span>
        <textarea id="msNote" rows="2" maxlength="300" placeholder="Optional">${B.esc(pending?.note || "")}</textarea></label>
      <div class="row" style="gap:8px"><button type="button" class="btn primary" data-ms="send">Send for approval</button><button type="button" class="btn ghost" data-ms="cancel">Cancel</button></div>`;
    }
    $("msBody").innerHTML = html;
    markChanged();
  }
  // Highlight edited rows and show times only for working days
  function markChanged() {
    if (!msEditing) return;
    const S = B.sched, p = msWk.staff.find((x) => x.id === me.id), ov = S.indexDays(p.days.map((d) => ({ ...d, staff_id: p.id })));
    $("msBody").querySelectorAll(".ms-row[data-d]").forEach((r) => {
      const [sel, a, b] = r.querySelectorAll("select, input");
      a.hidden = b.hidden = sel.value !== "shift";
      r.classList.toggle("chg", !sameDay({ kind: sel.value, start: a.value, end: b.value }, S.effective(p, r.dataset.d, ov)));
    });
  }
  $("msBody").addEventListener("change", markChanged);
  $("msBody").addEventListener("input", markChanged);
  $("msWeeks").addEventListener("click", (e) => { const b = e.target.closest("button[data-i]"); if (!b) return; msIdx = +b.dataset.i; msEditing = false; loadMySched(false); });
  $("msBody").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-ms]"); if (!b) return;
    const k = b.dataset.ms;
    if (k === "edit") { msEditing = true; return renderMySched(); }
    if (k === "cancel") { msEditing = false; return renderMySched(); }
    if (k === "withdraw") {
      const pnd = msReqs.find((r) => r.week_start === msFrom && r.status === "pending"); if (!pnd) return;
      b.disabled = true;
      const r = await api.cancelScheduleRequest(me.id, pin, pnd.id).catch((err) => ({ ok: false, error: err.message }));
      if (!r.ok) { b.disabled = false; return B.toast(r.error, "err"); }
      B.toast("Request withdrawn"); return loadMySched(true);
    }
    if (k === "send") {
      const S = B.sched, p = msWk.staff.find((x) => x.id === me.id), ov = S.indexDays(p.days.map((d) => ({ ...d, staff_id: p.id })));
      const days = {};
      for (const r of $("msBody").querySelectorAll(".ms-row[data-d]")) {
        const [sel, a, c] = r.querySelectorAll("select, input"), v = { kind: sel.value, start: a.value, end: c.value };
        if (v.kind === "shift" && (!v.start || !v.end)) return B.toast("Add a start and end time for each working day.", "err");
        if (!sameDay(v, S.effective(p, r.dataset.d, ov))) days[r.dataset.d] = v.kind === "shift" ? { kind: "shift", s: v.start, e: v.end } : { kind: v.kind };
      }
      if (!Object.keys(days).length) return B.toast("Nothing changed yet. Change a day first, or tap Cancel.", "err");
      b.disabled = true;
      const r = await api.requestWeek(me.id, pin, msFrom, days, $("msNote").value.trim()).catch((err) => ({ ok: false, error: err.message }));
      b.disabled = false;
      if (!r.ok) return B.toast(r.error, "err");
      msEditing = false; B.toast("Sent to the admin for approval"); loadMySched(true);
    }
  });
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
