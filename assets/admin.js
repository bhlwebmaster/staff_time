(function () {
  const B = window.BHL, api = B.api, A = api.admin;
  const $ = (id) => document.getElementById(id);
  let settings = null, staff = [], sheetRows = [], sheetOts = [], editing = null, editingStaff = null, role = null, meId = null;
  const TABS = () => role === "admin" ? ["today", "sheets", "reports", "schedule", "payroll", "staff", "settings", "access"] : ["today", "sheets", "reports", "schedule", "payroll", "access"];
  const tz = () => settings?.timezone || "Europe/London";
  const byId = (id) => staff.find((s) => s.id === id);
  const today = () => B.dateIn(new Date(), tz());
  const t = (iso) => (iso ? B.clockIn(new Date(iso), tz()) : "—");
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  // Simple pager: state = { page, size }; calls go() after a change. Hidden when everything fits on one page.
  const PAGE_SIZES = [10, 20, 50, 100];
  let printAll = false;   // while printing, every table shows all its rows
  const pg = (size = 20) => ({ page: 1, size, def: size });
  function pager(box, total, st, go) {
    const pages = Math.max(1, Math.ceil(total / st.size));
    st.page = Math.min(Math.max(1, st.page), pages);
    box.hidden = printAll || total <= Math.min(st.size, st.def || st.size);
    if (box.hidden) return printAll ? [0, total] : [(st.page - 1) * st.size, Math.min(total, st.page * st.size)];
    const a = (st.page - 1) * st.size, b = Math.min(total, a + st.size);
    box.innerHTML = `<span class="muted">Showing ${a + 1}–${b} of ${total}</span><span class="spacer"></span>
      <label class="muted">Rows <select aria-label="Rows per page">${PAGE_SIZES.map((n) => `<option ${n === st.size ? "selected" : ""}>${n}</option>`).join("")}</select></label>
      <button class="btn sm" type="button" data-pg="-1" ${st.page <= 1 ? "disabled" : ""}>‹ Prev</button>
      <span class="pg">Page ${st.page} of ${pages}</span>
      <button class="btn sm" type="button" data-pg="1" ${st.page >= pages ? "disabled" : ""}>Next ›</button>`;
    box.querySelector("select").onchange = (e) => { st.size = +e.target.value; st.page = 1; go(); };
    box.querySelectorAll("[data-pg]").forEach((btn) => { btn.onclick = () => { st.page += +btn.dataset.pg; go(); }; });
    return [a, b];
  }
  function renderVisible() {
    const on = (n) => !$("tab-" + n).hidden;
    if (on("today")) renderDay();
    if (on("sheets")) renderSheets();
    if (on("reports")) renderReport();
    if (on("schedule") && schFrom) renderSchedule();
    if (on("payroll") && curP) { renderPayroll(); renderFxHist(); }
    if (on("staff")) renderStaff();
    if (on("settings")) renderHolidays();
    if (on("access") && role === "admin") renderUsers();
  }
  window.addEventListener("beforeprint", () => { printAll = true; try { renderVisible(); } catch {} });
  window.addEventListener("afterprint", () => { printAll = false; try { renderVisible(); } catch {} });
  const friendly = (e) => /duplicate|unique/i.test(e.message) ? "There is already an entry for that person on that date." : e.message;

  // ---------- auth ----------
  let holidays = [];
  async function boot() {
    if (!api.ready) return;
    const session = await A.session();
    if (!session) return showLogin();
    role = await A.role().catch(() => null);
    if (!role) { await A.signOut(); return showLogin("This login doesn't have access. Ask an admin to add you under Access."); }
    document.body.classList.toggle("ro", role !== "admin");
    const me = await A.me().catch(() => null); meId = me?.id; $("meEmail").textContent = me?.email || "";
    $("vLogin").hidden = true; $("tabs").hidden = false; $("signOut").hidden = false;
    settings = await A.settings();
    [staff, holidays] = await Promise.all([A.staff(), A.holidays().catch(() => [])]);
    B.sched.setHolidays(holidays);
    fillPeople();
    setRange("tm");
    $("dayPick").value = today();
    $("rDay").value = today(); $("rMonth").value = today().slice(0, 7); $("rFrom").value = today().slice(0, 8) + "01"; $("rTo").value = today();
    const tab = (location.hash || "#today").slice(1);
    openTab(TABS().includes(tab) ? tab : "today");
    loadRequests(); setInterval(() => { if (!document.hidden) loadRequests(); }, 120000);
    tick(); setInterval(tick, 10000);
    setInterval(() => { if (!document.hidden && !$("tab-today").hidden && $("dayPick").value === today()) loadDay(); }, 60000);
  }
  function showLogin(msg) { $("vLogin").hidden = false; $("lMsg").textContent = msg || ""; }
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault(); $("lMsg").textContent = "Signing in…";
    try { await A.signIn($("lEmail").value.trim(), $("lPass").value); location.reload(); }
    catch (err) { $("lMsg").textContent = err.message; }
  };
  $("signOut").onclick = async () => { await A.signOut(); location.reload(); };
  function tick() { $("ukClock").textContent = B.clockIn(new Date(), tz()); }

  // ---------- tabs ----------
  function openTab(name) {
    for (const b of $("tabs").children) b.setAttribute("aria-selected", b.dataset.tab === name);
    if (!TABS().includes(name)) name = "today";
    for (const n of ["today", "sheets", "reports", "schedule", "payroll", "staff", "settings", "access"]) $("tab-" + n).hidden = n !== name;
    history.replaceState(null, "", "#" + name);
    ({ today: loadDay, sheets: loadSheets, staff: renderStaff, settings: renderSettings, access: loadUsers, reports: loadReport, payroll: loadPayroll, schedule: loadSchedule })[name]();
  }
  $("tabs").onclick = (e) => { const b = e.target.closest("button[data-tab]"); if (b) openTab(b.dataset.tab); };

  function fillPeople() {
    const opts = staff.map((s) => `<option value="${B.esc(s.id)}">${B.esc(s.display_name)}${s.active ? "" : " (inactive)"}</option>`).join("");
    $("who").innerHTML = `<option value="">Everyone</option>` + opts;
    $("eWho").innerHTML = opts;
    $("rWho").innerHTML = `<option value="">Everyone</option>` + opts;
  }
  function flagsHtml(c, isToday) {
    const f = [];
    if (c.late) f.push(`<span class="flag late">Late ${B.fmtMins(c.late)}</span>`);
    if (c.ot) f.push(`<span class="flag ot">OT +${B.fmtMins(c.ot)}</span>`);
    if (c.otUsed) f.push(`<span class="flag ot" title="OT from ${c.otFrom ? B.prettyDate(c.otFrom) : "the last work day"} used today">OT used ${B.fmtMins(c.otUsed)}</span>`);
    if (c.short) f.push(`<span class="flag short">Short ${B.fmtMins(c.short)}</span>`);
    if (c.after) f.push(`<span class="flag ot" title="Out-of-hours OT clocked before or after the shift (included in Worked)">Out-of-hours ${B.fmtMins(c.after)}</span>`);
    if (c.otRunning) f.push(`<span class="flag ot">On out-of-hours OT now</span>`);
    if (c.autoStopped) f.push(`<span class="flag miss" title="Nobody tapped End OT, so it stopped after 4 hours. Check the time in Edit.">OT auto-stopped</span>`);
    if (c.overCap) f.push(`<span class="flag miss" title="OT bank is over the cap in Settings">OT bank ${B.fmtMins(c.bankAfter)} · over cap</span>`);
    if (c.open && !isToday) f.push(`<span class="flag miss">No clock-out</span>`);
    if (c.noLunch) f.push(`<span class="flag short" title="Planned lunch ${c.planLunch} min, but no lunch was tapped. Worked time includes it.">No lunch logged</span>`);
    return f.join(" ");
  }
  /** Mark a day that has an auto-stopped after-hours OT session (needs an admin to check the time). */
  function otMarks(c, ots, staffId, date) {
    if (c && ots?.some((o) => o.staff_id === staffId && o.work_date === date && o.auto_stopped)) c.autoStopped = true;
    return c;
  }
  const lunchCell = (r) => r.lunch_out ? `${t(r.lunch_out)}–${r.lunch_in ? t(r.lunch_in) : "…"}` : "—";
  const pillFor = (c) => ({ in: ["in", "Working"], lunch: ["lunch", "On lunch"], out: ["out", "Clocked out"], absent: ["absent", "Not in"] }[c.status]);

  // ---------- today ----------
  const dayPg = pg(20); let dayData = null;
  async function loadDay() {
    const day = $("dayPick").value || today();
    // a few days before, so today knows the OT from each person's last work day
    const [pre, sdays, ots] = await Promise.all([A.attendance(addDays(day, -5), day), A.scheduleDays(day, day), A.otSessions(addDays(day, -1), day).catch(() => [])]);
    if (dayData?.day !== day) dayPg.page = 1;
    dayData = { day, pre, sdays, ots };
    renderDay();
  }
  function renderDay() {
    if (!dayData) return;
    const { day, pre, sdays, ots } = dayData;
    $("dayTitle").textContent = day === today() ? "Today · " + B.prettyDate(day) : B.prettyDate(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const rows = pre.filter((r) => r.work_date === day);
    const planOv = B.sched.indexDays(sdays);
    const act = staff.filter((s) => s.active || rows.some((r) => r.staff_id === s.id));
    let n = { in: 0, lunch: 0, out: 0, absent: 0, late: 0 };
    const [da, db] = pager($("dayPager"), act.length, dayPg, renderDay);
    $("dayRows").innerHTML = act.map((s, i) => {
      const r = rows.find((x) => x.staff_id === s.id);
      const plan = B.sched.effective(s, day, planOv);
      const c = r ? otMarks(B.calcDays(pre.filter((x) => x.staff_id === s.id), s, settings).get(day), ots, s.id, day) : { status: plan.kind === "shift" ? "absent" : "off" };
      if (ots.some((o) => o.staff_id === s.id && !o.ended_at)) c.otRunning = true;
      if (r && !r.time_in && plan.kind !== "shift" && c.status === "absent") c.status = "off";   // day off with only OT sessions
      if (c.status !== "off") n[c.status]++; if (c.late) n.late++;   // KPIs count everyone
      if (i < da || i >= db) return "";
      const [k, label] = c.otRunning ? ["in", "Out-of-hours OT"] : c.status === "off" ? ["out", B.sched.KINDS[plan.kind].label] : pillFor(c);
      let worked = "—";
      if (c.worked != null) worked = B.fmtMins(c.worked);
      else if (r?.time_in && day === today()) {
        const lunch = r.lunch_out ? ((r.lunch_in ? new Date(r.lunch_in) : new Date()) - new Date(r.lunch_out)) : 0;
        worked = `<span class="muted">${B.fmtMins(Math.max(0, (Date.now() - Math.max(new Date(r.time_in), c.schedStart) - lunch) / 60000))}</span>`;
      }
      return `<tr><td style="white-space:nowrap">${B.avatarHtml(s, 28)}<b>${B.esc(s.display_name)}</b></td><td><span class="pill ${k}">${label}</span></td>
        <td class="mono">${r ? `${B.clockStr(r.sched_start)}–${B.clockStr(r.sched_end)}` : plan.kind === "shift" ? `${B.clockStr(plan.start)}–${B.clockStr(plan.end)}` : "—"}</td>
        <td class="mono">${r ? t(r.time_in) : "—"}</td><td class="mono">${r ? lunchCell(r) : "—"}</td><td class="mono">${r ? t(r.time_out) : "—"}</td>
        <td class="num">${worked}</td><td>${r ? flagsHtml(c, day === today()) : ""}${r?.note ? `<span class="sub" title="${B.esc(r.note)}">${B.esc(r.note)}</span>` : ""}</td>
        <td><button class="btn sm adminonly" data-edit="${r ? B.esc(r.id) : ""}" data-staff="${B.esc(s.id)}" data-date="${day}">${r ? "Edit" : "Add"}</button></td></tr>`;
    }).join("") || `<tr><td colspan="9" class="muted">No staff yet. Add people in the Staff tab.</td></tr>`;
    $("dayKpis").innerHTML = [
      ["Working", n.in], ["On lunch", n.lunch], ["Clocked out", n.out], ["Not in", n.absent, n.absent && day === today()], ["Late", n.late, n.late],
    ].map(([l, v, w]) => `<div class="card kpi ${w ? "warn" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
    window._dayRows = rows;
  }
  $("dayPick").onchange = loadDay;
  $("dayRows").onclick = (e) => {
    const b = e.target.closest("button[data-staff]"); if (!b) return;
    const r = (window._dayRows || []).find((x) => x.id === b.dataset.edit);
    openEntry(r || null, { staff_id: b.dataset.staff, work_date: b.dataset.date });
  };

  // ---------- timesheets ----------
  function setRange(q) {
    const d = today(), dow = (new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7; // Monday = 0
    let f, to;
    if (q === "tw") { f = addDays(d, -dow); to = addDays(f, 6); }
    if (q === "lw") { f = addDays(d, -dow - 7); to = addDays(f, 6); }
    if (q === "tm") { f = d.slice(0, 8) + "01"; to = addDays(addDays(f, 32).slice(0, 8) + "01", -1); }
    if (q === "lm") { to = addDays(d.slice(0, 8) + "01", -1); f = to.slice(0, 8) + "01"; }
    $("from").value = f; $("to").value = to;
    for (const b of $("quick").children) b.classList.toggle("on", b.dataset.q === q);
  }
  $("quick").onclick = (e) => { const b = e.target.closest("button[data-q]"); if (b) { setRange(b.dataset.q); loadSheets(); } };
  for (const id of ["from", "to"]) $(id).onchange = () => { for (const b of $("quick").children) b.classList.remove("on"); loadSheets(); };
  $("who").onchange = () => { dailyPg.page = 1; renderSheets(); };

  async function loadSheets() {
    [sheetRows, sheetOts] = await Promise.all([A.attendance(addDays($("from").value, -5), $("to").value),   // earlier days only feed OT
      A.otSessions($("from").value, $("to").value).catch(() => [])]);
    dailyPg.page = sumPg.page = 1;
    renderSheets();
  }
  const dailyPg = pg(20), sumPg = pg(20);
  function computeSheets() {
    const who = $("who").value;
    const from = $("from").value;
    const people = staff.filter((s) => (!who || s.id === who) && (s.active || sheetRows.some((r) => r.staff_id === s.id && r.work_date >= from)));
    return people.map((s) => {
      const sum = B.summarise(sheetRows.filter((r) => r.staff_id === s.id), s, settings, today(), { from });
      for (const x of sum.days_list) otMarks(x.c, sheetOts, s.id, x.row.work_date);
      return { s, sum };
    });
  }
  function renderSheets() {
    const list = computeSheets();
    const period = `${B.prettyDate($("from").value, { day: "numeric", month: "short", year: "numeric" })} – ${B.prettyDate($("to").value, { day: "numeric", month: "short", year: "numeric" })}`;
    $("sheetTitle").textContent = period;
    $("printTitle").textContent = `${settings.company_name} · Timesheet · ${period}`;
    const tot = list.reduce((a, { sum }) => { for (const k of ["days", "worked", "regular", "ot", "otUsed", "short", "bank", "late", "missingOut", "billable"]) a[k] = (a[k] || 0) + sum[k]; return a; }, {});
    const overCap = list.filter(({ sum }) => sum.overCap);
    $("sheetKpis").innerHTML = [
      [B.hoursDec(tot.billable || 0), "billable hours"], [tot.days || 0, "days worked"],
      [B.fmtMins(tot.ot || 0), "OT earned (h:mm)"], [tot.late || 0, "late arrivals", tot.late], [tot.missingOut || 0, "missing clock-outs", tot.missingOut],
      ...(overCap.length ? [[overCap.map(({ s }) => s.display_name).join(", "), `OT bank over the ${B.fmtMins(settings.ot_bank_cap_mins ?? 480)} cap`, true]] : []),
    ].map(([v, l, w]) => `<div class="card kpi ${w ? "warn" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
    const cells = (x) => `<td class="num">${x.days}</td><td class="num">${B.fmtMins(x.worked)}</td><td class="num">${B.fmtMins(x.regular)}</td>
      <td class="num">${B.fmtMins(x.ot)}</td><td class="num">${B.fmtMins(x.otUsed)}</td>
      <td class="num" style="${x.short ? "color:var(--late)" : ""}">${B.fmtMins(x.short)}</td>
      <td class="num">${x.late}</td><td class="num" style="${x.missingOut ? "color:var(--late)" : ""}">${x.missingOut}</td><td class="num"><b>${B.hoursDec(x.billable)}</b></td>
      <td class="num" style="${x.overCap ? "color:var(--late)" : ""}" title="${x.overCap ? "Over the OT bank cap in Settings" : ""}">${x.carryBank != null ? B.fmtMins(x.carryBank) + (x.overCap ? " ⚠" : "") : "—"}</td>`;
    const [sa, sb] = pager($("sumPager"), list.length, sumPg, renderSheets);
    $("sumRows").innerHTML = list.slice(sa, sb).map(({ s, sum }) => `<tr class="click ${$("who").value === s.id ? "sel" : ""}" data-id="${B.esc(s.id)}"><td><b>${B.esc(s.display_name)}</b><span class="sub">${B.esc(s.full_name)}</span></td>${cells(sum)}</tr>`).join("")
      || `<tr><td colspan="11" class="muted">No entries in this period.</td></tr>`;
    $("sumFoot").innerHTML = list.length > 1 ? `<tr><td>Total</td>${cells(tot)}</tr>` : "";
    const days = list.flatMap(({ s, sum }) => sum.days_list.map((x) => ({ s, ...x }))).sort((a, b) => b.row.work_date.localeCompare(a.row.work_date) || a.s.display_name.localeCompare(b.s.display_name));
    const [pa, pb] = pager($("dailyPager"), days.length, dailyPg, renderSheets);
    $("dailyRows").innerHTML = days.slice(pa, pb).map(({ s, row: r, c }) => `<tr>
      <td class="mono">${B.prettyDate(r.work_date)}</td><td>${B.esc(s.display_name)}</td>
      <td class="mono">${B.clockStr(r.sched_start)}–${B.clockStr(r.sched_end)}</td>
      <td class="mono">${t(r.time_in)}</td><td class="mono">${lunchCell(r)}</td><td class="mono">${t(r.time_out)}</td>
      <td class="num">${c.worked != null ? B.fmtMins(c.worked) : "—"}</td><td>${flagsHtml(c, r.work_date === today())}</td>
      <td class="note">${B.esc(r.note || "")}</td><td class="noprint"><button class="btn sm adminonly" data-edit="${B.esc(r.id)}">Edit</button></td></tr>`).join("")
      || `<tr><td colspan="10" class="muted">No entries.</td></tr>`;
  }
  $("sumRows").onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (!tr) return; $("who").value = $("who").value === tr.dataset.id ? "" : tr.dataset.id; dailyPg.page = 1; renderSheets(); };
  $("dailyRows").onclick = (e) => { const b = e.target.closest("button[data-edit]"); if (b) openEntry(sheetRows.find((r) => r.id === b.dataset.edit)); };
  $("addEntry").onclick = () => openEntry(null, { staff_id: $("who").value || staff[0]?.id, work_date: today() });
  $("printBtn").onclick = () => window.print();

  function download(name, rows) {
    const csv = rows.map((r) => r.map((v) => { v = String(v ?? ""); return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; }).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: name });
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 2000);
  }
  const period = () => `${$("from").value}_to_${$("to").value}`;
  $("csvSum").onclick = () => download(`BHL-timesheet-summary_${period()}.csv`, [
    ["Name", "Timesheet name", "Period from", "Period to", "Days worked", "Worked hours", "Regular hours", "OT earned hours", "OT used hours", "Short hours (not covered)", "Late arrivals", "Late minutes", "Missing clock-outs", "Billable hours", "Out-of-hours OT hours", "OT bank hours (carry-over)"],
    ...computeSheets().map(({ s, sum }) => [s.display_name, s.full_name, $("from").value, $("to").value, sum.days, B.hoursDec(sum.worked), B.hoursDec(sum.regular),
      B.hoursDec(sum.ot), B.hoursDec(sum.otUsed), B.hoursDec(sum.short), sum.late, sum.lateMins, sum.missingOut, B.hoursDec(sum.billable), B.hoursDec(sum.after), sum.carryBank != null ? B.hoursDec(sum.carryBank) : ""]),
  ]);
  $("csvDay").onclick = () => download(`BHL-timesheet-daily_${period()}.csv`, [
    ["Date", "Name", "Timesheet name", "Sched start (UK)", "Sched end (UK)", "Time in (UK)", "Lunch out", "Lunch in", "Time out (UK)", "Worked hours", "Late minutes", "OT earned minutes", "OT used minutes", "Short minutes", "Note", "Out-of-hours OT minutes"],
    ...computeSheets().flatMap(({ s, sum }) => sum.days_list.map(({ row: r, c }) => [r.work_date, s.display_name, s.full_name, r.sched_start.slice(0, 5), r.sched_end.slice(0, 5),
      B.hhmmIn(c.tin, tz()), B.hhmmIn(c.lo, tz()), B.hhmmIn(c.li, tz()), B.hhmmIn(c.tout, tz()), c.worked != null ? B.hoursDec(c.worked) : "", c.late, c.ot, c.otUsed, c.short, r.note || "", c.after || 0])),
  ]);

  // ---------- entry dialog ----------
  async function openEntry(r, defaults = {}) {
    editing = r;
    const base = r || { staff_id: defaults.staff_id, work_date: defaults.work_date || today() };
    const s = byId(base.staff_id) || staff[0];
    if (!s) return B.toast("Add a staff member first.", "err");
    $("entryTitle").textContent = r ? `Edit · ${s.display_name}, ${B.prettyDate(r.work_date)}` : "Add entry";
    $("eWho").value = s.id; $("eWho").disabled = !!r; $("eDate").value = base.work_date; $("eDate").disabled = !!r;
    $("eSS").value = (r?.sched_start || s.sched_start).slice(0, 5); $("eSE").value = (r?.sched_end || s.sched_end).slice(0, 5);
    const h = (iso) => (iso ? B.hhmmIn(new Date(iso), tz()) : "");
    $("eIn").value = h(r?.time_in); $("eOut").value = h(r?.time_out); $("eLO").value = h(r?.lunch_out); $("eLI").value = h(r?.lunch_in);
    $("eNote").value = r?.note || "";
    $("eOtAdj").value = r?.ot_adjust || "";
    $("eDel").hidden = !r;
    $("eHist").innerHTML = "";
    $("eOtBox").hidden = !r || (!s.ot_carry_from && !r.after_mins);
    $("eOtList").innerHTML = "";
    $("entryDlg").showModal();
    if (r && !$("eOtBox").hidden) loadEntryOt();
    if (r) {
      const log = await A.audit(r.staff_id, r.work_date).catch(() => []);
      $("eHist").innerHTML = log.length ? `<b>History</b>` + log.map((l) => `<span>${new Date(l.at).toLocaleString("en-GB", { timeZone: tz(), dateStyle: "medium", timeStyle: "short" })} · ${B.esc(l.action)} by ${B.esc(l.actor)}</span>`).join("") : "";
    }
  }
  $("entryForm").onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const date = $("eDate").value;
    const iso = (v) => (v ? B.zonedToDate(date, v, tz()).toISOString() : null);
    const rec = { staff_id: $("eWho").value, work_date: date, sched_start: $("eSS").value, sched_end: $("eSE").value,
      time_in: iso($("eIn").value), lunch_out: iso($("eLO").value), lunch_in: iso($("eLI").value), time_out: iso($("eOut").value), note: $("eNote").value.trim() || null,
      ot_adjust: Math.max(0, Math.round(+$("eOtAdj").value || 0)) };
    // Changing the schedule here is an admin decision: it becomes the planned schedule for the day
    const hh = (t) => (t || "").slice(0, 5);
    if (!editing || hh(editing.sched_start) !== rec.sched_start || hh(editing.sched_end) !== rec.sched_end) { rec.plan_start = rec.sched_start; rec.plan_end = rec.sched_end; }
    const seq = [rec.time_in, rec.lunch_out, rec.lunch_in, rec.time_out].filter(Boolean);
    if (seq.some((v, i) => i && v < seq[i - 1])) return B.toast("Times must run in order: in → lunch out → lunch in → out.", "err");
    if (rec.sched_end <= rec.sched_start) return B.toast("Schedule end must be after start.", "err");
    try {
      await A.saveAttendance(editing ? { ...rec, id: editing.id } : rec);
      $("entryDlg").close(); B.toast("Saved"); refresh();
    } catch (err) { B.toast(friendly(err), "err"); }
  };
  // After-hours OT sessions for the day being edited (saved straight away, separately from the day's Save)
  let entryOts = [];
  async function loadEntryOt() {
    entryOts = (await A.otSessions(editing.work_date, editing.work_date).catch(() => [])).filter((o) => o.staff_id === editing.staff_id);
    renderEntryOt();
  }
  function renderEntryOt() {
    const h = (iso) => (iso ? B.hhmmIn(new Date(iso), tz()) : "");
    $("eOtList").innerHTML = entryOts.map((o, i) => `<div class="row otrow" data-i="${i}" style="gap:6px;flex-wrap:wrap">
      <input type="time" aria-label="Start" value="${h(o.started_at)}" style="width:auto"><span>–</span>
      <input type="time" aria-label="End" value="${h(o.ended_at)}" style="width:auto">
      ${o.auto_stopped ? `<span class="flag miss" title="Nobody tapped End OT">auto-stopped</span>` : ""}<span class="spacer"></span>
      <button class="btn sm" type="button" data-ot="save">Save</button><button class="btn ghost sm" type="button" data-ot="del">Delete</button>
      <input type="text" aria-label="Note" value="${B.esc(o.note || "")}" placeholder="Who asked and what for" style="flex:1 1 100%"></div>`).join("")
      || `<span class="muted" style="font-size:13px">None on this day.</span>`;
  }
  $("eOtAdd").onclick = () => { entryOts.push({ staff_id: editing.staff_id, work_date: editing.work_date, note: "" }); renderEntryOt(); };
  $("eOtList").onclick = async (e) => {
    const b = e.target.closest("button[data-ot]"); if (!b) return;
    const row = b.closest(".otrow"), o = entryOts[+row.dataset.i];
    if (b.dataset.ot === "del") {
      if (o.id) try { await A.deleteOtSession(o.id); } catch (err) { return B.toast(err.message, "err"); }
      entryOts.splice(+row.dataset.i, 1); renderEntryOt(); B.toast("Session deleted"); return refresh();
    }
    const [st, en, note] = row.querySelectorAll("input");
    if (!st.value || !en.value) return B.toast("Add a start and end time.", "err");
    if (!note.value.trim()) return B.toast("Add a note: who asked and what for.", "err");
    // An end time earlier than the start means it went past midnight (UK)
    const start = B.zonedToDate(o.work_date, st.value, tz());
    let end = B.zonedToDate(o.work_date, en.value, tz()); if (end <= start) end = B.zonedToDate(addDays(o.work_date, 1), en.value, tz());
    const rec = { staff_id: o.staff_id, work_date: o.work_date, started_at: start.toISOString(), ended_at: end.toISOString(), note: note.value.trim(), auto_stopped: false };
    try { await A.saveOtSession(o.id ? { ...rec, id: o.id } : rec); } catch (err) { return B.toast(friendly(err), "err"); }
    B.toast("Session saved"); await loadEntryOt(); refresh();
  };
  let delArmed = false;
  $("eDel").onclick = async () => {
    if (!delArmed) { delArmed = true; $("eDel").textContent = "Tap again to delete"; setTimeout(() => { delArmed = false; $("eDel").textContent = "Delete entry"; }, 4000); return; }
    delArmed = false; $("eDel").textContent = "Delete entry";
    try { await A.deleteAttendance(editing.id); $("entryDlg").close(); B.toast("Entry deleted"); refresh(); } catch (err) { B.toast(err.message, "err"); }
  };
  function refresh() { if (!$("tab-today").hidden) loadDay(); if (!$("tab-sheets").hidden) loadSheets(); }

  // ---------- staff ----------
  const staffPg = pg(20);
  function renderStaff() {
    const [a, b] = pager($("staffPager"), staff.length, staffPg, renderStaff);
    $("staffRows").innerHTML = staff.slice(a, b).map((s) => `<tr>
      <td style="white-space:nowrap">${B.avatarHtml(s, 28)}<b>${B.esc(s.display_name)}</b></td><td>${B.esc(s.full_name)}</td>
      <td class="mono">${B.clockStr(s.sched_start)}–${B.clockStr(s.sched_end)}</td><td class="num">${s.lunch_mins}m</td>
      <td class="num">${B.fmtMins(B.standardMins(s))}</td>
      <td>${s.has_pin ? `<span class="pill in">Set</span>` : `<span class="pill absent">Not yet</span>`}</td>
      <td>${s.active ? "Active" : `<span class="muted">Inactive</span>`}</td>
      <td><button class="btn sm" data-id="${B.esc(s.id)}">Edit</button></td></tr>`).join("")
      || `<tr><td colspan="8" class="muted">No one yet. Add your first team member.</td></tr>`;
  }
  $("staffRows").onclick = (e) => { const b = e.target.closest("button[data-id]"); if (b) openStaff(byId(b.dataset.id)); };
  $("addStaff").onclick = () => openStaff(null);
  function openStaff(s) {
    editingStaff = s;
    $("staffTitle").textContent = s ? s.display_name : "Add person";
    $("pDisp").value = s?.display_name || ""; $("pFull").value = s?.full_name || "";
    $("pSS").value = (s?.sched_start || "06:00").slice(0, 5); $("pSE").value = (s?.sched_end || "15:00").slice(0, 5);
    $("pLunch").value = s?.lunch_mins ?? 60; $("pActive").value = String(s?.active ?? true);
    $("pStartDate").value = s?.start_date || ""; $("pRate").value = s?.pay_rate ?? "";
    $("pPayType").value = s ? B.payroll.payType(s.pay_type) : "bimonthly"; payTypeLabel();
    renderPattern(s);
    $("pOt").checked = !!s?.ot_carry_from; $("pOtFrom").value = s?.ot_carry_from || today(); $("pOtFromRow").hidden = !s?.ot_carry_from;
    $("pReset").hidden = !s?.has_pin;
    $("pPhotoRow").hidden = !s?.photo; $("pAv").innerHTML = s ? B.avatarHtml(s, 36) : "";
    $("staffDlg").showModal();
  }
  $("staffForm").onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const rec = { display_name: $("pDisp").value.trim(), full_name: $("pFull").value.trim().toUpperCase(), sched_start: $("pSS").value, sched_end: $("pSE").value,
      lunch_mins: +$("pLunch").value, active: $("pActive").value === "true",
      start_date: $("pStartDate").value || null, pay_rate: $("pRate").value === "" ? null : +$("pRate").value, pay_type: $("pPayType").value, week_pattern: readPattern(),
      ot_carry_from: $("pOt").checked ? $("pOtFrom").value || today() : null };
    if (rec.week_pattern && Object.values(rec.week_pattern).some((d) => d && d.e <= d.s)) return B.toast("In the usual week, each end time must be after its start time.", "err");
    if (rec.sched_end <= rec.sched_start) return B.toast("End must be after start.", "err");
    try {
      await A.saveStaff(editingStaff ? { ...rec, id: editingStaff.id } : rec);
      staff = await A.staff(); fillPeople(); renderStaff(); $("staffDlg").close(); B.toast("Saved");
    } catch (err) { B.toast(err.message, "err"); }
  };
  $("pOt").onchange = () => { $("pOtFromRow").hidden = !$("pOt").checked; if (!$("pOtFrom").value) $("pOtFrom").value = today(); };
  $("pPhotoRm").onclick = async () => {
    try { await A.saveStaff({ id: editingStaff.id, photo: null }); staff = await A.staff(); renderStaff(); $("pPhotoRow").hidden = true; B.toast(`Photo removed for ${editingStaff.display_name}`); }
    catch (err) { B.toast(err.message, "err"); }
  };
  $("pReset").onclick = async () => {
    try { await A.resetPin(editingStaff.id); staff = await A.staff(); renderStaff(); $("pReset").hidden = true; B.toast(`PIN cleared for ${editingStaff.display_name}`); }
    catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- settings ----------
  function renderSettings() {
    $("stCompany").value = settings.company_name; $("stTz").value = settings.timezone;
    $("stGrace").value = settings.grace_mins; $("stBlock").value = settings.ot_block_mins; $("stEarly").checked = settings.count_early;
    $("stDpc").value = settings.days_per_cutoff ?? 10;
    $("stCap").value = (settings.ot_bank_cap_mins ?? 480) / 60;
    $("stDaily").value = (settings.ot_daily_use_mins ?? 180) / 60;
    $("stFlex").checked = settings.flex_hours !== false;
    renderHolidays();
    loadReminders();
  }
  // ---------- shift reminders (push notifications) ----------
  const REM = { start: ["Before the shift starts", "minutes before start"], lunch: ["Lunch break nudge", "minutes after start"], end: ["Before the shift ends", "minutes before end"] };
  let remRules = [];
  async function loadReminders() {
    try { [remRules] = await Promise.all([A.notifyRules()]); } catch (err) { $("remRules").innerHTML = `<p class="muted" style="margin:0">Reminders aren't set up in the database yet. Run supabase/database-update.sql.</p>`; return; }
    $("remKey").value = settings.push_public_key || "";
    $("remRules").innerHTML = Object.keys(REM).map((k) => { const r = remRules.find((x) => x.kind === k) || { kind: k, enabled: false, offset_mins: 30, title: "", body: "" };
      return `<div class="stack rem" data-k="${k}" style="gap:6px;padding:12px;border:1px solid var(--line);border-radius:12px">
        <div class="row" style="gap:10px;flex-wrap:wrap"><label class="check" style="margin:0"><input type="checkbox" data-f="enabled" ${r.enabled ? "checked" : ""}> <b>${REM[k][0]}</b></label><span class="spacer"></span>
          <label class="row" style="gap:6px;align-items:center;font-size:13px"><input type="number" data-f="offset_mins" min="0" max="720" value="${r.offset_mins}" style="width:90px"> ${REM[k][1]}</label></div>
        <input type="text" data-f="title" maxlength="60" value="${B.esc(r.title)}" placeholder="Title" aria-label="${REM[k][0]} title">
        <textarea data-f="body" rows="2" maxlength="240" placeholder="Message" aria-label="${REM[k][0]} message">${B.esc(r.body)}</textarea></div>`; }).join("");
    try {
      const phones = await A.pushPhones(), per = {};
      for (const p of phones) per[p.staff_id] = (per[p.staff_id] || 0) + 1;
      const names = Object.entries(per).map(([id, n]) => `${byId(id)?.display_name || "?"}${n > 1 ? ` (${n})` : ""}`);
      $("remPhones").textContent = names.length ? `Reminders on: ${names.join(", ")}` : "No phones have reminders on yet.";
    } catch { $("remPhones").textContent = ""; }
  }
  $("remForm").onsubmit = async (e) => {
    e.preventDefault();
    const rows = [...$("remRules").querySelectorAll(".rem")].map((d) => ({ kind: d.dataset.k, enabled: d.querySelector('[data-f="enabled"]').checked,
      offset_mins: Math.max(0, Math.min(720, Math.round(+d.querySelector('[data-f="offset_mins"]').value || 0))),
      title: d.querySelector('[data-f="title"]').value.trim(), body: d.querySelector('[data-f="body"]').value.trim() }));
    if (rows.some((r) => !r.title || !r.body)) return B.toast("Each reminder needs a title and a message.", "err");
    const key = $("remKey").value.trim() || null;
    try { await A.saveNotifyRules(rows); await A.saveSettings({ push_public_key: key }); settings.push_public_key = key; B.toast("Reminders saved"); }
    catch (err) { B.toast(err.message, "err"); }
  };
  $("remTest").onclick = async () => {
    $("remTest").disabled = true;
    try { const r = await A.testPush(); B.toast(r.phones ? `Test sent to ${r.sent} of ${r.phones} phone${r.phones > 1 ? "s" : ""}` : "No phones have reminders on yet."); }
    catch (err) { B.toast(err.message, "err"); }
    $("remTest").disabled = false;
  };

  $("setForm").onsubmit = async (e) => {
    e.preventDefault();
    const s = { company_name: $("stCompany").value.trim(), timezone: $("stTz").value, grace_mins: +$("stGrace").value,
      ot_block_mins: Math.max(1, +$("stBlock").value), count_early: $("stEarly").checked, flex_hours: $("stFlex").checked, days_per_cutoff: Math.max(1, Math.round(+$("stDpc").value || 10)),
      ot_bank_cap_mins: Math.max(0, Math.round((+$("stCap").value || 0) * 60)),
      ot_daily_use_mins: Math.max(0, Math.round((+$("stDaily").value || 0) * 60)) };
    try { await A.saveSettings(s); settings = { ...settings, ...s }; B.toast("Settings saved"); } catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- public holidays ----------
  const holPg = pg(10);
  function renderHolidays() {
    const years = [...new Set([today().slice(0, 4), ...holidays.map((h) => String(h.holiday_date).slice(0, 4))])].sort();
    const cur = $("holYear").value || today().slice(0, 4);
    $("holYear").innerHTML = years.map((y) => `<option ${y === cur ? "selected" : ""}>${y}</option>`).join("");
    const list = holidays.filter((h) => String(h.holiday_date).startsWith($("holYear").value)).sort((a, b) => String(b.holiday_date).localeCompare(String(a.holiday_date))), edit = role === "admin";
    const [ha, hb] = pager($("holPager"), list.length, holPg, renderHolidays);
    $("holTable").innerHTML = `<thead><tr><th>Date</th><th>Holiday</th><th>Type</th><th>Paid</th>${edit ? "<th></th>" : ""}</tr></thead><tbody>${list.slice(ha, hb).map((h) => `<tr data-d="${h.holiday_date}">
      <td class="num">${B.prettyDate(h.holiday_date, { weekday: "short", day: "numeric", month: "short" })}</td><td>${B.esc(h.name)}</td>
      <td>${h.kind === "special" ? "Special non-working" : "Regular"}</td>
      <td><input type="checkbox" data-paid ${h.paid !== false ? "checked" : ""} ${edit ? "" : "disabled"} aria-label="Paid"></td>
      ${edit ? `<td><button class="btn ghost sm" type="button" data-rm>Remove</button></td>` : ""}</tr>`).join("") || `<tr><td colspan="5" class="muted">No holidays for this year yet.</td></tr>`}</tbody>`;
  }
  async function reloadHolidays() { holidays = await A.holidays(); B.sched.setHolidays(holidays); renderHolidays(); }
  $("holYear").onchange = () => { holPg.page = 1; renderHolidays(); };
  $("holTable").addEventListener("change", async (e) => {
    const cb = e.target.closest("input[data-paid]"); if (!cb) return;
    const h = holidays.find((x) => x.holiday_date === cb.closest("tr").dataset.d);
    try { await A.saveHoliday({ ...h, paid: cb.checked }); h.paid = cb.checked; B.sched.setHolidays(holidays); B.toast(cb.checked ? "Paid holiday" : "Marked as unpaid (no work, no pay)"); }
    catch (err) { cb.checked = !cb.checked; B.toast(err.message, "err"); }
  });
  $("holTable").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-rm]"); if (!b) return;
    const d = b.closest("tr").dataset.d;
    if (b.dataset.armed !== "1") { b.dataset.armed = "1"; b.textContent = "Click again"; return; }
    try { await A.deleteHoliday(d); location.reload(); } catch (err) { B.toast(err.message, "err"); }
  });
  $("holForm").onsubmit = async (e) => {
    e.preventDefault();
    const h = { holiday_date: $("holDate").value, name: $("holName").value.trim(), kind: $("holKind").value, paid: true };
    if (!h.holiday_date || !h.name) return;
    try { await A.saveHoliday(h); $("holName").value = ""; $("holYear").value = h.holiday_date.slice(0, 4); await reloadHolidays(); B.toast("Holiday added"); }
    catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- reports (tally by day / week / month / custom) ----------
  let rType = "week", report = null;
  const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const mondayOf = (ds) => addDays(ds, -((new Date(ds + "T12:00:00Z").getUTCDay() + 6) % 7));
  const lastOfMonth = (ym) => addDays(addDays(ym + "-01", 32).slice(0, 8) + "01", -1);
  const daysBetween = (a, b) => Math.round((new Date(b + "T12:00:00Z") - new Date(a + "T12:00:00Z")) / 864e5);
  const fmtD = (ds, o = { day: "numeric", month: "short" }) => B.prettyDate(ds, o);
  const long = { day: "numeric", month: "short", year: "numeric" };

  function reportRange() {
    if (rType === "day") { const d = $("rDay").value || today(); return { from: d, to: d, title: "Daily report", period: B.prettyDate(d, { weekday: "long", day: "numeric", month: "long", year: "numeric" }) }; }
    if (rType === "week") { const f = mondayOf($("rDay").value || today()), t2 = addDays(f, 6); return { from: f, to: t2, title: "Weekly report", period: `Week of ${fmtD(f, long)} – ${fmtD(t2, long)}` }; }
    if (rType === "month") { const m = $("rMonth").value || today().slice(0, 7); return { from: m + "-01", to: lastOfMonth(m), title: "Monthly report", period: B.prettyDate(m + "-01", { month: "long", year: "numeric" }) }; }
    let f = $("rFrom").value || today(), t2 = $("rTo").value || f; if (t2 < f) [f, t2] = [t2, f];
    return { from: f, to: t2, title: "Custom report", period: `${fmtD(f, long)} – ${fmtD(t2, long)}` };
  }
  // Columns for the tally: days for a week or a short range, weeks for a month or medium range, months for long ranges.
  function buckets(from, to) {
    const span = daysBetween(from, to) + 1, out = [];
    if (rType === "day") return [{ from, to, label: fmtD(from), sub: "" }];
    if (rType === "week" || (rType === "custom" && span <= 14)) {
      for (let d = from; d <= to; d = addDays(d, 1)) out.push({ from: d, to: d, label: DOW[(new Date(d + "T12:00:00Z").getUTCDay() + 6) % 7], sub: fmtD(d) });
      return out;
    }
    if (rType === "month" || span <= 120) {
      let i = 1;
      for (let f = from; f <= to; ) { const e = [addDays(mondayOf(f), 6), to].sort()[0]; out.push({ from: f, to: e, label: `Week ${i++}`, sub: `${fmtD(f)}–${fmtD(e)}` }); f = addDays(e, 1); }
      return out;
    }
    for (let f = from; f <= to; ) { const e = [lastOfMonth(f.slice(0, 7)), to].sort()[0]; out.push({ from: f, to: e, label: B.prettyDate(f, { month: "short" }), sub: f.slice(0, 4) }); f = addDays(e, 1); }
    return out;
  }
  function setType(t) {
    rType = t;
    for (const b of $("repType").children) b.setAttribute("aria-pressed", b.dataset.t === t);
    $("rDayL").hidden = !(t === "day" || t === "week"); $("rDayL").firstChild.textContent = t === "week" ? "Any day in the week" : "Date";
    $("rMonthL").hidden = t !== "month"; $("rFromL").hidden = $("rToL").hidden = t !== "custom"; $("rStep").hidden = t === "custom";
    loadReport();
  }
  $("repType").onclick = (e) => { const b = e.target.closest("button[data-t]"); if (b) setType(b.dataset.t); };
  for (const id of ["rDay", "rMonth", "rFrom", "rTo"]) $(id).onchange = loadReport;
  $("rWho").onchange = () => { matrixPg.page = repPg.page = 1; renderReport(); };
  function step(n) {
    if (rType === "day") $("rDay").value = addDays($("rDay").value || today(), n);
    if (rType === "week") $("rDay").value = addDays($("rDay").value || today(), 7 * n);
    if (rType === "month") { const d = new Date(($("rMonth").value || today().slice(0, 7)) + "-15T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); $("rMonth").value = d.toISOString().slice(0, 7); }
    loadReport();
  }
  $("rPrev").onclick = () => step(-1); $("rNext").onclick = () => step(1);
  $("rNow").onclick = () => { $("rDay").value = today(); $("rMonth").value = today().slice(0, 7); loadReport(); };

  const matrixPg = pg(20), repPg = pg(20);
  async function loadReport() {
    const R = reportRange();
    const all = await A.attendance(addDays(R.from, -5), R.to);   // earlier days only feed OT
    report = { R, rows: all.filter((r) => r.work_date >= R.from), all };
    matrixPg.page = repPg.page = 1;
    renderReport();
  }
  function buildReport() {
    const { R, rows } = report, who = $("rWho").value;
    const cols = buckets(R.from, R.to);
    const people = staff.filter((s) => (!who || s.id === who) && (s.active || rows.some((r) => r.staff_id === s.id)));
    const lines = people.map((s) => {
      const sum = B.summarise(report.all.filter((r) => r.staff_id === s.id), s, settings, today(), { from: R.from });
      const cells = cols.map((c) => sum.days_list.filter((x) => x.row.work_date >= c.from && x.row.work_date <= c.to && x.c.complete).reduce((a, x) => a + x.c.worked, 0));
      const has = cols.map((c) => sum.days_list.some((x) => x.row.work_date >= c.from && x.row.work_date <= c.to && x.c.tin));
      return { s, sum, cells, has };
    });
    const tot = lines.reduce((a, l) => { for (const k of ["days", "worked", "regular", "ot", "short", "bank", "late", "missingOut", "billable"]) a[k] = (a[k] || 0) + l.sum[k]; return a; }, {});
    const colTot = cols.map((_, i) => lines.reduce((a, l) => a + l.cells[i], 0));
    const detail = lines.flatMap((l) => l.sum.days_list.map((x) => ({ s: l.s, ...x }))).sort((a, b) => b.row.work_date.localeCompare(a.row.work_date) || a.s.display_name.localeCompare(b.s.display_name));   // newest first
    return { R, cols, lines, tot, colTot, detail };
  }
  function renderReport() {
    if (!report) return;
    const X = buildReport(), { R, cols, lines, tot, colTot } = X;
    $("repTitle").textContent = R.title; $("repSub").textContent = R.period;
    $("repKpis").innerHTML = [
      [B.fmtMins(tot.worked || 0), "hours worked"], [B.hoursDec(tot.billable || 0), "billable hours"], [tot.days || 0, "days worked"],
      [B.fmtMins(tot.ot || 0), "OT earned"], [tot.late || 0, "late arrivals", tot.late], [tot.missingOut || 0, "missing clock-outs", tot.missingOut],
    ].map(([v, l, w]) => `<div class="card kpi ${w ? "warn" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
    $("matrixTitle").textContent = rType === "day" ? "Hours today" : cols[0]?.label.startsWith("Week") ? "Hours by week" : cols.length && /^\d{4}$/.test(cols[0].sub) ? "Hours by month" : "Hours by day";
    const cell = (m, has) => has ? `<td class="num">${B.fmtMins(m)}</td>` : `<td class="num zero">–</td>`;
    const showCols = rType !== "day";
    const [ma, mb] = pager($("matrixPager"), lines.length, matrixPg, renderReport);
    const [ra, rb] = pager($("repPager"), X.detail.length, repPg, renderReport);
    $("matrix").innerHTML = `<thead><tr><th>Name</th>${showCols ? cols.map((c) => `<th class="num">${c.label}<span class="d">${c.sub}</span></th>`).join("") : ""}
        <th class="num tot">Worked</th><th class="num">Regular</th><th class="num">OT</th><th class="num">Short</th><th class="num">Late</th><th class="num tot">Billable hrs</th></tr></thead>
      <tbody>${lines.slice(ma, mb).map((l) => `<tr><td><b>${B.esc(l.s.display_name)}</b><span class="sub">${B.esc(l.s.full_name)}</span></td>
        ${showCols ? l.cells.map((m, i) => cell(m, l.has[i])).join("") : ""}
        <td class="num tot"><b>${B.fmtMins(l.sum.worked)}</b></td><td class="num">${B.fmtMins(l.sum.regular)}</td><td class="num">${B.fmtMins(l.sum.ot)}</td>
        <td class="num">${B.fmtMins(l.sum.short)}</td><td class="num">${l.sum.late}</td><td class="num tot"><b>${B.hoursDec(l.sum.billable)}</b></td></tr>`).join("")
        || `<tr><td colspan="${cols.length + 7}" class="muted">No staff match this filter.</td></tr>`}</tbody>
      ${lines.length > 1 ? `<tfoot><tr><td>Total</td>${showCols ? colTot.map((m) => `<td class="num">${B.fmtMins(m)}</td>`).join("") : ""}
        <td class="num tot">${B.fmtMins(tot.worked)}</td><td class="num">${B.fmtMins(tot.regular)}</td><td class="num">${B.fmtMins(tot.ot)}</td>
        <td class="num">${B.fmtMins(tot.short)}</td><td class="num">${tot.late}</td><td class="num tot">${B.hoursDec(tot.billable)}</td></tr></tfoot>` : ""}`;
    $("repDetail").innerHTML = `<thead><tr><th>Date</th><th>Name</th><th>Schedule</th><th>In</th><th>Lunch</th><th>Out</th><th class="num">Worked</th><th>Flags</th><th>Note</th></tr></thead>
      <tbody>${X.detail.slice(ra, rb).map(({ s, row: r, c }) => `<tr><td class="mono">${B.prettyDate(r.work_date)}</td><td>${B.esc(s.display_name)}</td>
        <td class="mono">${B.clockStr(r.sched_start)}–${B.clockStr(r.sched_end)}</td><td class="mono">${t(r.time_in)}</td><td class="mono">${lunchCell(r)}</td>
        <td class="mono">${t(r.time_out)}</td><td class="num">${c.worked != null ? B.fmtMins(c.worked) : "—"}</td><td>${flagsHtml(c, r.work_date === today())}</td>
        <td class="note">${B.esc(r.note || "")}</td></tr>`).join("") || `<tr><td colspan="9" class="muted">No entries in this period.</td></tr>`}</tbody>`;
  }

  const fileBase = () => { const { R } = report; return `BHL-${R.title.split(" ")[0].toLowerCase()}-report_${R.from}${R.to !== R.from ? "_to_" + R.to : ""}`; };
  $("rCsv").onclick = () => {
    if (!report) return;
    const X = buildReport(), showCols = rType !== "day";
    download(fileBase() + ".csv", [
      [settings.company_name, X.R.title, X.R.period],
      [],
      ["Name", "Timesheet name", ...(showCols ? X.cols.map((c) => `${c.label} ${c.sub}`.trim() + " (hrs)") : []), "Worked hrs", "Regular hrs", "OT hrs", "Short hrs", "Late arrivals", "Billable hrs"],
      ...X.lines.map((l) => [l.s.display_name, l.s.full_name, ...(showCols ? l.cells.map((m, i) => (l.has[i] ? B.hoursDec(m) : "")) : []),
        B.hoursDec(l.sum.worked), B.hoursDec(l.sum.regular), B.hoursDec(l.sum.ot), B.hoursDec(l.sum.short), l.sum.late, B.hoursDec(l.sum.billable)]),
      ["Total", "", ...(showCols ? X.colTot.map(B.hoursDec) : []), B.hoursDec(X.tot.worked || 0), B.hoursDec(X.tot.regular || 0), B.hoursDec(X.tot.ot || 0), B.hoursDec(X.tot.short || 0), X.tot.late || 0, B.hoursDec(X.tot.billable || 0)],
    ]);
  };

  $("rPdf").onclick = () => {
    if (!report) return;
    if (!window.jspdf?.jsPDF) return B.toast("PDF tools didn't load. Check your connection and reload.", "err");
    const X = buildReport(), showCols = rType !== "day";
    const doc = new window.jspdf.jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    const W = doc.internal.pageSize.getWidth(), M = 40, ink = [21, 32, 27], muted = [91, 106, 98], green = [13, 118, 86];
    // header
    doc.setFillColor(...green); doc.roundedRect(M, 34, 26, 26, 5, 5, "F");
    doc.setTextColor(255); doc.setFont("helvetica", "bold"); doc.setFontSize(8.5); doc.text("BHL", M + 13, 50, { align: "center" });
    doc.setTextColor(...ink); doc.setFontSize(17); doc.text(`${X.R.title}: work hours`, M + 36, 46);
    doc.setFont("helvetica", "normal"); doc.setFontSize(10); doc.setTextColor(...muted);
    doc.text(`${settings.company_name} · ${X.R.period}${$("rWho").value ? " · " + byId($("rWho").value).display_name : ""}`, M + 36, 60);
    doc.text(`Generated ${new Date().toLocaleString("en-GB", { timeZone: tz(), dateStyle: "medium", timeStyle: "short" })} UK`, W - M, 46, { align: "right" });
    // KPI strip
    const k = [["Hours worked", B.fmtMins(X.tot.worked || 0)], ["Billable hours", B.hoursDec(X.tot.billable || 0)], ["Days worked", String(X.tot.days || 0)],
      ["OT earned", B.fmtMins(X.tot.ot || 0)], ["Late arrivals", String(X.tot.late || 0)], ["Missing clock-outs", String(X.tot.missingOut || 0)]];
    const kw = (W - 2 * M) / k.length;
    k.forEach(([l, v], i) => {
      const x = M + i * kw; doc.setDrawColor(214, 222, 214); doc.roundedRect(x + 2, 74, kw - 4, 42, 4, 4, "S");
      doc.setFont("courier", "bold"); doc.setFontSize(14); doc.setTextColor(...ink); doc.text(v, x + 10, 94);
      doc.setFont("helvetica", "normal"); doc.setFontSize(8); doc.setTextColor(...muted); doc.text(l, x + 10, 108);
    });
    const head = ["Name", ...(showCols ? X.cols.map((c) => c.sub && !/^\d{4}$/.test(c.sub) ? `${c.label}\n${c.sub}` : c.label) : []), "Worked", "Regular", "OT", "Short", "Late", "Billable hrs"];
    const body = X.lines.map((l) => [`${l.s.display_name}\n${l.s.full_name}`, ...(showCols ? l.cells.map((m, i) => (l.has[i] ? B.fmtMins(m) : "–")) : []),
      B.fmtMins(l.sum.worked), B.fmtMins(l.sum.regular), B.fmtMins(l.sum.ot), B.fmtMins(l.sum.short), String(l.sum.late), B.hoursDec(l.sum.billable)]);
    const foot = X.lines.length > 1 ? [["Total", ...(showCols ? X.colTot.map((m) => B.fmtMins(m)) : []), B.fmtMins(X.tot.worked), B.fmtMins(X.tot.regular),
      B.fmtMins(X.tot.ot), B.fmtMins(X.tot.short), String(X.tot.late), B.hoursDec(X.tot.billable)]] : [];
    const numStyles = {}; for (let i = 1; i < head.length; i++) numStyles[i] = { halign: "right", font: "courier" };
    const common = { theme: "grid", margin: { left: M, right: M, bottom: 40 }, styles: { fontSize: 8.5, cellPadding: 4, lineColor: [214, 222, 214], textColor: ink },
      headStyles: { fillColor: [232, 237, 231], textColor: muted, fontStyle: "bold", fontSize: 7.5 }, footStyles: { fillColor: [232, 237, 231], textColor: ink, fontStyle: "bold" } };
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.setTextColor(...ink); doc.text("Hours per person (h:mm, after unpaid lunch)", M, 138);
    doc.autoTable({ ...common, startY: 146, head: [head], body, foot, columnStyles: numStyles,
      didParseCell: (d) => { if (d.section !== "head" && d.column.index === head.length - 1) d.cell.styles.fontStyle = "bold"; if (d.section === "foot" && d.column.index > 0) d.cell.styles.halign = "right"; } });
    // daily detail
    let y = doc.lastAutoTable.finalY + 26;
    if (y > doc.internal.pageSize.getHeight() - 90) { doc.addPage(); y = 50; }
    doc.setFont("helvetica", "bold"); doc.setFontSize(11); doc.text("Daily detail (UK time)", M, y);
    doc.autoTable({ ...common, startY: y + 8,
      head: [["Date", "Name", "Schedule", "In", "Lunch", "Out", "Worked", "Late", "OT", "Short", "Note"]],
      body: X.detail.map(({ s, row: r, c }) => [B.prettyDate(r.work_date), s.display_name, `${B.clockStr(r.sched_start)}–${B.clockStr(r.sched_end)}`,
        r.time_in ? t(r.time_in) : "—", r.lunch_out ? lunchCell(r) : "—", r.time_out ? t(r.time_out) : (c.open && r.work_date !== today() ? "MISSING" : "—"),
        c.worked != null ? B.fmtMins(c.worked) : "—", c.late ? B.fmtMins(c.late) : "", c.ot ? B.fmtMins(c.ot) : "", c.short ? B.fmtMins(c.short) : "", r.note || ""]),
      columnStyles: { 6: { halign: "right", font: "courier" }, 7: { halign: "right", textColor: [178, 59, 42] }, 8: { halign: "right", textColor: green }, 9: { halign: "right" }, 10: { cellWidth: 170 } },
      didParseCell: (d) => { if (d.section === "body" && d.column.index === 5 && d.cell.raw === "MISSING") { d.cell.styles.textColor = [178, 59, 42]; d.cell.styles.fontStyle = "bold"; } } });
    // footer on every page
    const n = doc.getNumberOfPages();
    for (let i = 1; i <= n; i++) {
      doc.setPage(i); doc.setFont("helvetica", "normal"); doc.setFontSize(7.5); doc.setTextColor(...muted);
      const H = doc.internal.pageSize.getHeight();
      doc.text(`Rules: OT credited in ${settings.ot_block_mins}-min blocks · late after ${settings.grace_mins} min grace · billable = regular + OT`, M, H - 20);
      doc.text(`Page ${i} of ${n}`, W - M, H - 20, { align: "right" });
    }
    doc.save(fileBase() + ".pdf");
    B.toast("PDF downloaded");
  };

  // ---------- weekly schedule ----------
  const S = B.sched;
  (function () { const st = document.createElement("style"); st.textContent = S.CSS; document.head.appendChild(st); })();
  let schFrom = null, schDays = [], schDraft = {};
  const DSHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  function payTypeLabel() {
    const t = B.payroll.TYPES[$("pPayType").value] || B.payroll.TYPES.daily;
    $("pRateLabel").textContent = t.rateLabel; $("pRate").placeholder = t.eg;
  }
  $("pPayType").onchange = payTypeLabel;
  function renderPattern(s) {
    const base = s || { sched_start: "06:00:00", sched_end: "15:00:00" };
    const defLunch = s?.lunch_mins ?? (+$("pLunch")?.value || 60);
    $("pPattern").innerHTML = `<div class="pr pr-head"><span>Day</span><span>Start</span><span>End</span><span>Lunch (min)</span></div>` + [1, 2, 3, 4, 5, 6, 0].map((d) => {
      const x = S.patternDay({ ...base, week_pattern: s?.week_pattern ?? null }, d), raw = s?.week_pattern?.[String(d)];
      const st = x.kind === "shift" ? x.start : S.hhmm(base.sched_start), en = x.kind === "shift" ? x.end : S.hhmm(base.sched_end);
      const l = raw && raw.l != null ? raw.l : defLunch;
      return `<div class="pr" data-d="${d}"><label><input type="checkbox" ${x.kind === "shift" ? "checked" : ""}> ${DSHORT[d]}</label>
        <input type="time" value="${st}" aria-label="${DSHORT[d]} start"><input type="time" value="${en}" aria-label="${DSHORT[d]} end">
        <input type="number" min="0" max="240" step="5" value="${l}" aria-label="${DSHORT[d]} lunch minutes"></div>`; }).join("");
  }
  function readPattern() {
    const out = {};
    for (const r of $("pPattern").querySelectorAll(".pr")) {
      if (!r.dataset.d) continue;
      const [cb, a, b, l] = r.querySelectorAll("input");
      out[r.dataset.d] = cb.checked ? { s: a.value, e: b.value, l: Math.max(0, Math.round(+l.value || 0)) } : null;
    }
    return out;
  }
  // ---------- staff change requests ----------
  let reqs = [];
  async function loadRequests() {
    try { reqs = await A.scheduleRequests(); } catch { reqs = []; }
    $("reqBadge").textContent = reqs.length; $("reqBadge").hidden = !reqs.length;
    if ($("tab-schedule").hidden) return;
    $("schReqs").hidden = !reqs.length;
    if (!reqs.length) return;
    const weeks = reqs.map((r) => r.week_start).sort();
    const cur = S.indexDays(await A.scheduleDays(weeks[0], S.addDays(weeks[weeks.length - 1], 6)).catch(() => []));
    const plain = (e) => e.kind === "shift" ? `${S.ampm(e.start)}–${S.ampm(e.end)}` : S.KINDS[e.kind]?.label || e.kind;
    $("reqList").innerHTML = reqs.map((r) => {
      const s = byId(r.staff_id); if (!s) return "";
      const rows = Object.keys(r.days).sort().map((d) => {
        const v = r.days[d], want = { kind: v.kind, start: v.s, end: v.e }, now = S.effective(s, d, cur);
        const same = now.kind === want.kind && (want.kind !== "shift" || (now.start === want.start && now.end === want.end));
        return `<tr><td>${DSHORT[S.dow(d)]} ${+d.slice(8)}</td><td class="old">${plain(now)}</td><td>→</td><td class="${same ? "same" : "new"}">${same ? "already the same" : plain(want)}</td></tr>`;
      }).join("");
      return `<div class="req" data-id="${r.id}">
        <div class="req-h">${B.avatarHtml(s, 26)}${B.esc(s.display_name)} · week of ${B.prettyDate(r.week_start, { day: "numeric", month: "short" })}
          <span class="muted">sent ${B.prettyDate(B.dateIn(new Date(r.created_at), tz()))}</span></div>
        <table class="req-t">${rows}</table>
        ${r.note ? `<div class="note">“${B.esc(r.note)}”</div>` : ""}
        ${role === "admin" ? `<div class="acts"><input placeholder="Message to ${B.esc(s.display_name)} (optional)" aria-label="Message">
          <button class="btn primary sm" data-dec="1">Approve</button><button class="btn sm" data-dec="0">Reject</button></div>` : `<div class="muted" style="font-size:12.5px">Waiting for an admin.</div>`}
      </div>`;
    }).join("");
  }
  $("reqList").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-dec]"); if (!b) return;
    const card = b.closest(".req"), approve = b.dataset.dec === "1";
    card.querySelectorAll("button").forEach((x) => (x.disabled = true));
    try {
      const r = await A.decideScheduleRequest(card.dataset.id, approve, card.querySelector("input")?.value.trim());
      if (!r.ok) throw new Error(r.error);
      B.toast(approve ? "Approved. The schedule is updated." : "Rejected. The person will see your message.");
      loadSchedule(schFrom);
    } catch (err) { B.toast(err.message, "err"); card.querySelectorAll("button").forEach((x) => (x.disabled = false)); }
  });

  async function loadSchedule(from) {
    loadRequests();
    schFrom = from || schFrom || S.weekStart(today());
    const end = S.addDays(schFrom, 6);
    schDays = await A.scheduleDays(schFrom, end);
    schDraft = {};
    const ov = S.indexDays(schDays);
    for (const s of staff.filter((x) => x.active)) for (let i = 0; i < 7; i++) { const d = S.addDays(schFrom, i); schDraft[s.id + "|" + d] = S.effective(s, d, ov); }
    $("schTitle").textContent = `${B.prettyDate(schFrom, { day: "numeric", month: "long" })} – ${B.prettyDate(end, { day: "numeric", month: "long", year: "numeric" })}`;
    renderSchedule();
  }
  function isChanged(s, d, e) {
    const u = S.effective(s, d, null);   // usual week, with public holidays
    return e.kind !== u.kind || (e.kind === "shift" && (e.start !== u.start || e.end !== u.end));
  }
  const schPg = pg(20);
  function renderSchedule() {
    const edit = role === "admin", days = Array.from({ length: 7 }, (_, i) => S.addDays(schFrom, i)), t = today();
    const people = staff.filter((x) => x.active);
    const [sa, sb] = pager($("schPager"), people.length, schPg, renderSchedule);
    $("schGrid").innerHTML = `<thead><tr><th>Name</th>${days.map((d) => `<th class="${d === t ? "is-today" : ""}">${S.DAY[S.dow(d)]}<br>${+d.slice(8)}</th>`).join("")}</tr></thead>
      <tbody>${people.slice(sa, sb).map((s) => `<tr><th>${B.avatarHtml(s, 24)}${B.esc(s.display_name)}</th>${days.map((d) => {
        const e = schDraft[s.id + "|" + d], ch = isChanged(s, d, e);
        if (!edit) return `<td><div class="sch-cell k-${e.kind} ${ch ? "changed" : ""}"><span class="sch-ro">${S.cellText(e)}</span></div></td>`;
        return `<td><div class="sch-cell k-${e.kind} ${ch ? "changed" : ""}" data-k="${s.id}|${d}">
          <select aria-label="${B.esc(s.display_name)} ${d}">${Object.entries(S.KINDS).map(([k, v]) => `<option value="${k}" ${k === e.kind ? "selected" : ""}>${v.label}</option>`).join("")}</select>
          ${e.kind === "shift" ? `<div class="t"><input type="time" value="${e.start || ""}" aria-label="start"><input type="time" value="${e.end || ""}" aria-label="end"></div>` : ""}
        </div></td>`; }).join("")}</tr>`).join("") || `<tr><td colspan="8" class="muted">No active staff.</td></tr>`}</tbody>`;
    $("schTimeline").innerHTML = S.timelineHtml(schFrom, people, Object.fromEntries(Object.entries(schDraft).map(([k, e]) => [k, { kind: e.kind, start_time: e.start, end_time: e.end }])), t);
  }
  $("schGrid").addEventListener("change", (e) => {
    const cell = e.target.closest(".sch-cell[data-k]"); if (!cell) return;
    const cur = schDraft[cell.dataset.k], [sid] = cell.dataset.k.split("|"), s = byId(sid);
    const sel = cell.querySelector("select"), times = cell.querySelectorAll("input[type=time]");
    const kind = sel.value;
    if (kind === "shift") {
      const u = S.patternDay(s, S.dow(cell.dataset.k.split("|")[1]));
      schDraft[cell.dataset.k] = { kind, start: times[0]?.value || cur.start || u.start || S.hhmm(s.sched_start), end: times[1]?.value || cur.end || u.end || S.hhmm(s.sched_end) };
    } else schDraft[cell.dataset.k] = { kind, start: cur.start, end: cur.end };
    renderSchedule();
  });
  $("schPrev").onclick = () => loadSchedule(S.addDays(schFrom, -7));
  $("schNext").onclick = () => loadSchedule(S.addDays(schFrom, 7));
  $("schNow").onclick = () => loadSchedule(S.weekStart(today()));
  $("schReset").onclick = () => {
    for (const k of Object.keys(schDraft)) { const [sid, d] = k.split("|"); schDraft[k] = S.effective(byId(sid), d, null); }
    renderSchedule(); B.toast("Reset to everyone's usual week. Click Save week to keep it.");
  };
  $("schCopy").onclick = async () => {
    const pf = S.addDays(schFrom, -7), prev = S.indexDays(await A.scheduleDays(pf, S.addDays(pf, 6)));
    for (const k of Object.keys(schDraft)) { const [sid, d] = k.split("|"); schDraft[k] = S.effective(byId(sid), S.addDays(d, -7), prev); }
    renderSchedule(); B.toast("Copied last week. Click Save week to keep it.");
  };
  $("schSave").onclick = async () => {
    const existing = S.indexDays(schDays), up = [], del = [];
    for (const [k, e] of Object.entries(schDraft)) {
      const [sid, d] = k.split("|"), s = byId(sid);
      if (e.kind === "shift" && (!e.start || !e.end || e.end <= e.start)) return B.toast(`${s.display_name}, ${B.prettyDate(d)}: end time must be after start time.`, "err");
      if (isChanged(s, d, e)) up.push({ staff_id: sid, work_date: d, kind: e.kind, start_time: e.kind === "shift" ? e.start : null, end_time: e.kind === "shift" ? e.end : null });
      else if (existing[k]) del.push(existing[k].id);
    }
    try { await A.saveScheduleDays(up); await A.deleteScheduleDays(del); B.toast("Week saved. Staff see it on the homepage."); loadSchedule(schFrom); }
    catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- payroll ----------
  const P = B.payroll;
  (function () { const st = document.createElement("style"); st.textContent = P.SLIP_CSS; document.head.appendChild(st); })();
  let periods = [], curP = null, payLines = [], payOver = {}, payRows = [], payPlanOv = {};
  const isAdminRole = () => role === "admin";
  const payPg = pg(20);
  async function loadPayroll(keepId) {
    periods = await A.periods();
    $("payEmpty").hidden = periods.length > 0; $("payBody").hidden = !periods.length;
    $("payEditPeriod").hidden = !periods.length;
    renderFxHist();
    $("paySel").innerHTML = periods.map((p) => `<option value="${p.id}">${P.period(p)}${p.status === "final" ? " · final" : " · draft"}</option>`).join("");
    if (!periods.length) { $("payStatusLine").textContent = ""; return; }
    const id = keepId || $("paySel").value || periods[0].id;
    $("paySel").value = periods.some((p) => p.id === id) ? id : periods[0].id;
    await openPeriod($("paySel").value);
  }
  $("paySel").onchange = () => openPeriod($("paySel").value);
  async function openPeriod(id) {
    if (curP?.id !== id) payPg.page = 1;
    curP = periods.find((p) => p.id === id);
    const [saved, rows, sdays] = await Promise.all([A.payslips(id), A.attendance(addDays(curP.start_date, -5), curP.end_date), A.scheduleDays(curP.start_date, curP.end_date)]);
    payRows = rows; payPlanOv = B.sched.indexDays(sdays);
    payOver = {}; for (const r of saved) payOver[r.staff_id] = { ...(r.overrides || {}) };
    if (curP.status === "final") payLines = saved.map((r) => ({ ...r, auto: null }));
    $("payFx").value = curP.exchange_rate ?? ""; $("payFee").value = curP.transfer_fee ?? 0;
    renderProof(); renderFxHist();
    recalc();
  }

  // ---------- exchange-rate proof (screenshot per pay period; admin + finance only) ----------
  const PROOF_TYPES = ["image/png", "image/jpeg", "image/webp", "image/heic", "application/pdf"];
  const isPdf = (name) => /\.pdf$/i.test(name || "");
  function renderProof() {
    const has = !!curP.fx_proof_path, edit = isAdminRole() && curP.status !== "final";
    const when = curP.fx_proof_uploaded_at ? new Date(curP.fx_proof_uploaded_at).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
    $("payProof").className = "fxproof " + (has ? "has" : curP.status === "final" ? "" : "missing");
    $("payProofInfo").innerHTML = has
      ? `${B.esc(curP.fx_proof_name || "screenshot")}${when ? ` · uploaded ${B.esc(when)}` : ""}${curP.fx_proof_uploaded_by ? ` by ${B.esc(curP.fx_proof_uploaded_by)}` : ""}`
      : `<span class="miss">No screenshot yet.</span> ${isAdminRole() ? "Upload the rate the transfer was sent at; it's needed before finalising." : "An admin needs to upload it."}`;
    $("payProofView").hidden = !has;
    $("payProofPick").hidden = !edit;
    $("payProofPickTxt").textContent = has ? "Replace" : "Upload screenshot";
    $("payProofDel").hidden = !has || !edit;
  }
  function setPeriod(saved) {
    const i = periods.findIndex((p) => p.id === saved.id);
    if (i >= 0) periods[i] = { ...periods[i], ...saved };
    if (curP?.id === saved.id) curP = periods[i] || { ...curP, ...saved };
  }
  $("payProofFile").onchange = async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file || !curP) return;
    if (file.type && !PROOF_TYPES.includes(file.type)) return B.toast("Use a PNG, JPG, WEBP or HEIC screenshot, or a PDF.", "err");
    if (file.size > 5 * 1024 * 1024) return B.toast("That file is over 5 MB. Crop or compress the screenshot and try again.", "err");
    const old = curP.fx_proof_path, periodId = curP.id;
    $("payProofPickTxt").textContent = "Uploading…";
    let path = null;
    try {
      path = await A.fxProofUpload(periodId, file);
      setPeriod(await A.savePeriod({ id: periodId, fx_proof_path: path, fx_proof_name: file.name.slice(0, 120) }));
      if (old) A.fxProofRemove(old).catch(() => {});
      B.toast(old ? "Screenshot replaced" : "Screenshot uploaded");
    } catch (err) {
      if (path) A.fxProofRemove(path).catch(() => {});
      B.toast(err.message, "err");
    }
    if (curP?.id === periodId) renderProof();
    renderFxHist();
  };
  let delProof = false;
  $("payProofDel").onclick = async () => {
    if (!delProof) { delProof = true; $("payProofDel").textContent = "Click again to remove"; setTimeout(() => { delProof = false; $("payProofDel").textContent = "Remove"; }, 4000); return; }
    delProof = false; $("payProofDel").textContent = "Remove";
    const old = curP.fx_proof_path;
    try { setPeriod(await A.savePeriod({ id: curP.id, fx_proof_path: null })); await A.fxProofRemove(old).catch(() => {}); B.toast("Screenshot removed"); }
    catch (err) { B.toast(err.message, "err"); }
    renderProof(); renderFxHist();
  };
  $("payProofView").onclick = () => viewProof(curP);
  async function viewProof(p) {
    if (!p?.fx_proof_path) return;
    $("fxTitle").textContent = `Exchange-rate proof · ${P.period(p)}`;
    $("fxMeta").textContent = `${p.exchange_rate ? `Rate entered: ₱${Number(p.exchange_rate).toFixed(4)} per £1 · ` : "No rate entered yet · "}${p.fx_proof_name || ""}`;
    $("fxView").innerHTML = `<p class="muted">Loading…</p>`; $("fxOpen").removeAttribute("href");
    $("fxDlg").showModal();
    try {
      const url = await A.fxProofUrl(p.fx_proof_path);
      $("fxOpen").href = url;
      $("fxView").innerHTML = isPdf(p.fx_proof_path) ? `<iframe title="Exchange-rate proof" src="${B.esc(url)}"></iframe>` : `<img alt="Exchange-rate screenshot for ${B.esc(P.period(p))}" src="${B.esc(url)}">`;
    } catch (err) { $("fxView").innerHTML = `<p class="muted">${B.esc(err.message)}</p>`; }
  }

  // Exchange rates by period (all periods, newest first, paginated)
  const fxPg = { page: 1, size: 10 };
  const fmtWhen = (iso) => iso ? new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
  function renderFxHist() {
    const [a, b] = pager($("fxPager"), periods.length, fxPg, renderFxHist);
    $("fxRows").innerHTML = periods.slice(a, b).map((p) => `<tr class="click ${curP?.id === p.id ? "sel" : ""}" data-id="${B.esc(p.id)}">
      <td><b>${B.esc(P.period(p))}</b></td>
      <td class="mono">${B.prettyDate(p.pay_date, { day: "numeric", month: "short", year: "numeric" })}</td>
      <td class="num">${p.exchange_rate != null ? Number(p.exchange_rate).toFixed(4) : "—"}</td>
      <td class="num">${P.PHP(p.transfer_fee || 0)}</td>
      <td>${p.status === "final" ? `<span class="pill out">Final</span>` : `<span class="pill lunch">Draft</span>`}</td>
      <td>${p.fx_proof_path ? `<button class="btn sm" type="button" data-view="${B.esc(p.id)}">View</button>` : `<span class="miss">Missing</span>`}</td>
      <td class="note">${p.fx_proof_path ? `${B.esc(fmtWhen(p.fx_proof_uploaded_at))}${p.fx_proof_uploaded_by ? `<span class="sub">${B.esc(p.fx_proof_uploaded_by)}</span>` : ""}` : ""}</td></tr>`).join("")
      || `<tr><td colspan="7" class="muted">No pay periods yet.</td></tr>`;
  }
  $("fxRows").onclick = (e) => {
    const v = e.target.closest("button[data-view]");
    if (v) return viewProof(periods.find((p) => p.id === v.dataset.view));
    const tr = e.target.closest("tr[data-id]"); if (!tr) return;
    $("paySel").value = tr.dataset.id; openPeriod(tr.dataset.id);
    $("tab-payroll").scrollIntoView({ behavior: "smooth", block: "start" });
  };
  $("fxCsv").onclick = () => download(`BHL-exchange-rates_${today()}.csv`, [
    ["Period start", "Period end", "Pay date", "Exchange rate (PHP per GBP)", "Transfer fee (PHP)", "Status", "Proof uploaded", "Uploaded at", "Uploaded by"],
    ...periods.map((p) => [p.start_date, p.end_date, p.pay_date, p.exchange_rate ?? "", p.transfer_fee ?? 0, p.status, p.fx_proof_path ? "Yes" : "No", p.fx_proof_uploaded_at || "", p.fx_proof_uploaded_by || ""])]);
  $("fxDlg").addEventListener("close", () => { $("fxView").innerHTML = ""; });
  function people() {
    return staff.filter((s) => (s.active && (!s.start_date || s.start_date <= curP.end_date)) || payRows.some((r) => r.staff_id === s.id) || payOver[s.id]);
  }
  function recalc() {
    const final = curP.status === "final";
    if (!final) {
      const p = { ...curP, exchange_rate: $("payFx").value === "" ? null : +$("payFx").value, transfer_fee: +$("payFee").value || 0 };
      payLines = P.finish(people().map((s) => P.compute(s, payRows, p, settings, payOver[s.id] || {}, undefined, (d) => B.sched.effective(s, d, payPlanOv))), p);
    }
    renderPayroll();
  }
  $("payFx").oninput = () => { if (curP?.status !== "final") recalc(); };
  $("payFee").oninput = () => { if (curP?.status !== "final") recalc(); };

  function renderPayroll() {
    const final = curP.status === "final", edit = !final && isAdminRole();
    $("payStatusLine").innerHTML = `${P.period(curP)} · paid ${B.prettyDate(curP.pay_date, { day: "numeric", month: "short", year: "numeric" })} · ` +
      (final ? `<span class="pill out">Final · staff can see payslips</span>` : `<span class="pill lunch">Draft · not visible to staff</span>`);
    $("payFx").disabled = $("payFee").disabled = !edit;
    $("paySave").hidden = $("payFinal").hidden = final; $("payReopen").hidden = !final;
    const noRate = payLines.filter((l) => !l.rate).map((l) => l.employee_name);
    $("payHint").innerHTML = (noRate.length ? `<span class="warn">No pay rate set for ${noRate.map(B.esc).join(", ")}. Add it under Staff → Edit.</span> ` : "") +
      (edit ? "Days and hours worked, lates, undertime and absences are filled in from attendance, the schedule and public holidays. Hours only affect hourly pay. Type in any box to change it (it turns orange); click ↺ to go back to the attendance value." : final ? "This period is locked. Reopen it to make changes." : "");
    const T = P.totals(payLines);
    const inp = (l, k, cls = "") => {
      const ov = payOver[l.staff_id]?.[k];
      if (!edit) return k === "other_note" ? B.esc(l.other_note || "") : (k === "other_ded" ? P.GBP(l[k]) : l[k]);
      const has = ov !== undefined && ov !== "";
      const autoV = l.auto ? l.auto[k] : "";
      const val = has ? ov : autoV;
      const num = k !== "other_note";
      return `<span class="cellin"><input class="${cls} ${has ? "ov" : ""}" data-s="${l.staff_id}" data-k="${k}" value="${B.esc(val ?? "")}"
        ${num ? 'type="number" step="any" min="0"' : 'maxlength="40" placeholder="e.g. Cash advance"'} aria-label="${k.replace(/_/g, " ")} for ${B.esc(l.employee_name)}"
        title="${has ? `Changed by admin. From attendance: ${autoV}` : "From attendance. Type to change."}">${has ? `<button type="button" class="undo" data-s="${l.staff_id}" data-k="${k}" title="Back to the attendance value (${B.esc(autoV)})" aria-label="Reset to ${B.esc(autoV)}">↺</button>` : ""}</span>`;
    };
    const [pa, pb] = pager($("payPager"), payLines.length, payPg, renderPayroll);   // TOTAL row still covers everyone
    $("paySheet").innerHTML = `<thead><tr><th style="text-align:left">Employee name</th><th>Start date</th><th>Payroll period</th><th>Rate</th>
      <th>Days worked</th><th>Hours<br>worked</th><th>Lates<br>(mins)</th><th>Undertime<br>(mins)</th><th>Absences</th><th>Other deductions<br>(CA, loans, taxes)</th><th>Note</th>
      <th>Total deductions</th><th>Gross pay</th><th>Net pay</th><th>Exchange rate</th><th>Gross pay<br>(PHP)</th><th>Net pay<br>(PHP)</th><th>Fee share</th><th>Received<br>(PHP)</th></tr></thead>
      <tbody>${payLines.slice(pa, pb).map((l) => `<tr>
        <td><b>${B.esc(l.employee_name)}</b></td><td class="num">${P.usDate(l.start_date)}</td><td>${P.period(curP)}</td>
        <td class="num">${P.GBP(l.rate)}<span class="sub">${P.TYPES[l.pay_type].short}${l.pay_type === "hourly" ? ` · ${l.paid_hours} h paid` : l.pay_type === "daily" ? ` · ${l.paid_days} paid` : ""}</span></td><td class="num">${inp(l, "days_worked")}</td><td class="num">${inp(l, "hours_worked")}</td><td class="num">${inp(l, "late_mins")}</td>
        <td class="num">${inp(l, "undertime_mins")}</td><td class="num">${inp(l, "absences")}</td><td class="num">${inp(l, "other_ded")}</td><td>${inp(l, "other_note", "note")}</td>
        <td class="num">${P.GBP(l.total_ded)}</td><td class="num">${P.GBP(l.gross)}</td><td class="num"><b>${P.GBP(l.net)}</b></td>
        <td class="num">${l.exchange_rate ? Number(l.exchange_rate).toFixed(2) : "—"}</td><td class="num">${P.PHP(l.gross_php)}</td><td class="num hl">${P.PHP(l.net_php)}</td>
        <td class="num">${((+l.fee_share || 0) * 100).toFixed(2)}%</td><td class="num"><b>${P.PHP(l.received_php)}</b></td></tr>`).join("")
        || `<tr><td colspan="19" class="muted">No active staff in this period.</td></tr>`}</tbody>
      <tfoot><tr><td colspan="11" style="text-align:right">TOTAL</td><td class="num">${P.GBP(T.total_ded)}</td><td class="num">${P.GBP(T.gross)}</td><td class="num">${P.GBP(T.net)}</td>
        <td></td><td class="num">${P.PHP(T.gross_php)}</td><td class="num">${P.PHP(T.net_php)}</td><td></td><td class="num">${P.PHP(T.received_php)}</td></tr></tfoot>`;
    const cur = $("slipWho").value;
    $("slipWho").innerHTML = payLines.map((l) => `<option value="${l.staff_id}">${B.esc(l.employee_name)}</option>`).join("");
    if (payLines.some((l) => l.staff_id === cur)) $("slipWho").value = cur;
    renderSlip();
  }
  $("paySheet").addEventListener("change", (e) => {
    const i = e.target.closest("input[data-s]"); if (!i) return;
    const o = (payOver[i.dataset.s] ||= {}), k = i.dataset.k;
    const line = payLines.find((l) => l.staff_id === i.dataset.s), autoV = line?.auto?.[k];
    const v = k === "other_note" ? i.value.trim() : i.value === "" ? "" : +i.value;
    // Same as attendance (or emptied) = no override; anything else is kept as the admin's value
    if (v === "" || v === autoV || (k === "other_note" && !v)) delete o[k]; else o[k] = v;
    recalc();
  });
  $("paySheet").addEventListener("click", (e) => {
    const b = e.target.closest("button.undo"); if (!b) return;
    delete payOver[b.dataset.s]?.[b.dataset.k]; recalc();
  });
  const slipData = (l) => ({ ...l, period_start: curP.start_date, period_end: curP.end_date, pay_date: curP.pay_date });
  function renderSlip() {
    const l = payLines.find((x) => x.staff_id === $("slipWho").value);
    $("slipView").innerHTML = l ? P.slipHtml(slipData(l), settings.company_name) : "";
  }
  $("slipWho").onchange = renderSlip;
  function pdfDoc() { if (!window.jspdf?.jsPDF) { B.toast("PDF tools didn't load. Reload the page and try again.", "err"); return null; } return new window.jspdf.jsPDF({ unit: "pt", format: "a4" }); }
  const fileSafe = (t) => t.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-|-$/g, "");
  $("slipPdf").onclick = () => {
    const l = payLines.find((x) => x.staff_id === $("slipWho").value); if (!l) return;
    const doc = pdfDoc(); if (!doc) return;
    P.slipPdf(doc, slipData(l), settings.company_name, true);
    doc.save(`Payslip_${fileSafe(l.employee_name)}_${curP.start_date}_to_${curP.end_date}.pdf`);
  };
  $("payPdfAll").onclick = () => {
    if (!payLines.length) return; const doc = pdfDoc(); if (!doc) return;
    payLines.forEach((l, i) => P.slipPdf(doc, slipData(l), settings.company_name, i === 0));
    doc.save(`Payslips_${curP.start_date}_to_${curP.end_date}.pdf`);
  };
  $("payCsv").onclick = () => download(`Payroll_${curP.start_date}_to_${curP.end_date}.csv`, [
    ["Employee name", "Start date", "Payroll period", "Pay type", "Rate (GBP)", "Paid days", "Paid hours", "Days worked", "Hours worked", "Lates (mins)", "Undertime (mins)", "Absences", "Late ded (GBP)", "Undertime ded (GBP)",
      "Absence ded (GBP)", "Other deductions (GBP)", "Note", "Total deductions (GBP)", "Gross pay (GBP)", "Net pay (GBP)", "Exchange rate", "Gross pay (PHP)", "Net pay (PHP)",
      "Transfer fee share", "Transfer fee (PHP)", "Amount received (PHP)"],
    ...payLines.map((l) => [l.employee_name, P.usDate(l.start_date), P.period(curP), P.TYPES[l.pay_type].label, l.rate, l.paid_days, l.paid_hours, l.days_worked, l.hours_worked, l.late_mins, l.undertime_mins, l.absences, l.late_ded,
      l.undertime_ded, l.absence_ded, l.other_ded, l.other_note || "", l.total_ded, l.gross, l.net, l.exchange_rate ?? "", l.gross_php ?? "", l.net_php ?? "",
      ((+l.fee_share || 0) * 100).toFixed(2) + "%", l.fee_php ?? "", l.received_php ?? ""]),
  ]);
  const KEEP = ["employee_name", "start_date", "rate", "pay_type", "paid_days", "paid_hours", "days_scheduled", "days_worked", "hours_worked", "late_mins", "undertime_mins", "absences", "late_ded", "undertime_ded",
    "absence_ded", "other_ded", "other_note", "total_ded", "gross", "net", "exchange_rate", "gross_php", "net_php", "fee_share", "fee_php", "received_php"];
  async function savePayroll(status) {
    const p = { id: curP.id, exchange_rate: $("payFx").value === "" ? null : +$("payFx").value, transfer_fee: +$("payFee").value || 0 };
    if (status === "final") {
      if (!p.exchange_rate) return B.toast("Enter the exchange rate before finalising.", "err");
      if (!curP.fx_proof_path) return B.toast("Upload the exchange-rate screenshot before finalising.", "err");
      if (payLines.some((l) => !l.rate)) return B.toast("Some people have no pay rate. Set it under Staff first.", "err");
    }
    const rows = payLines.map((l) => { const r = { period_id: curP.id, staff_id: l.staff_id, overrides: payOver[l.staff_id] || {}, updated_at: new Date().toISOString() };
      for (const k of KEEP) r[k] = l[k] ?? null; r.other_note = l.other_note || null; return r; });
    try {
      await A.savePeriod(p);
      if (rows.length) await A.savePayslips(rows);
      if (status) await A.savePeriod({ id: curP.id, status });
      B.toast(status === "final" ? "Finalised. Staff can now see their payslips." : "Draft saved");
      await loadPayroll(curP.id);
    } catch (err) { B.toast(err.message, "err"); }
  }
  $("paySave").onclick = () => savePayroll(null);
  let finArmed = false;
  $("payFinal").onclick = () => {
    if (!finArmed) { finArmed = true; $("payFinal").textContent = "Click again to publish to staff"; setTimeout(() => { finArmed = false; $("payFinal").textContent = "Finalise & publish"; }, 4000); return; }
    finArmed = false; $("payFinal").textContent = "Finalise & publish"; savePayroll("final");
  };
  $("payReopen").onclick = async () => { try { await A.savePeriod({ id: curP.id, status: "draft" }); B.toast("Reopened. Staff can't see this period until you finalise again."); loadPayroll(curP.id); } catch (e) { B.toast(e.message, "err"); } };

  // period dialog
  let editingPeriod = null;
  const cutLabel = (c) => `${+c.start_date.slice(8)}–${+c.end_date.slice(8)} ${B.prettyDate(c.start_date, { month: "long", year: "numeric" })}`;
  function fillCut(c) { $("ppStart").value = c.start_date; $("ppEnd").value = c.end_date; $("ppPay").value = P.addDays(c.end_date, 1); }
  function openPeriodDlg(p) {
    editingPeriod = p;
    const last = periods[0];
    // New period: the cut-off after the latest one, or the current cut-off (1–15 / 16–end)
    const def = p ? P.cutoffOf(p.start_date) : last ? P.nextCutoff(P.cutoffOf(last.end_date)) : P.cutoffOf(today());
    const opts = []; let c = P.prevCutoff(P.prevCutoff(def));
    for (let i = 0; i < 7; i++) { opts.push(c); c = P.nextCutoff(c); }
    const isCut = !p || (p.start_date === def.start_date && p.end_date === def.end_date);
    $("ppCut").innerHTML = opts.map((o) => `<option value="${o.start_date}|${o.end_date}" ${o.start_date === def.start_date && isCut ? "selected" : ""}>${cutLabel(o)}</option>`).join("")
      + `<option value="" ${isCut ? "" : "selected"}>Custom dates</option>`;
    $("periodTitle").textContent = p ? "Edit pay period" : "New pay period";
    if (p) { $("ppStart").value = p.start_date; $("ppEnd").value = p.end_date; $("ppPay").value = p.pay_date; } else fillCut(def);
    $("ppFx").value = p?.exchange_rate ?? (last?.exchange_rate ?? ""); $("ppFee").value = p?.transfer_fee ?? 0;
    $("ppDel").hidden = !p; $("periodDlg").showModal();
  }
  $("ppCut").onchange = () => { const v = $("ppCut").value; if (!v) return; const [a, b] = v.split("|"); fillCut({ start_date: a, end_date: b }); };
  ["ppStart", "ppEnd"].forEach((id) => $(id).addEventListener("input", () => { $("ppCut").value = ""; }));
  $("payNewPeriod").onclick = () => openPeriodDlg(null);
  $("payFirst").onclick = () => openPeriodDlg(null);
  $("payEditPeriod").onclick = () => openPeriodDlg(curP);
  $("periodForm").onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return; e.preventDefault();
    const rec = { start_date: $("ppStart").value, end_date: $("ppEnd").value, pay_date: $("ppPay").value,
      exchange_rate: $("ppFx").value === "" ? null : +$("ppFx").value, transfer_fee: +$("ppFee").value || 0 };
    if (rec.end_date < rec.start_date) return B.toast("The period must end after it starts.", "err");
    try { const saved = await A.savePeriod(editingPeriod ? { ...rec, id: editingPeriod.id } : rec); $("periodDlg").close(); B.toast("Pay period saved"); loadPayroll(saved?.id || editingPeriod?.id); }
    catch (err) { B.toast(err.message, "err"); }
  };
  let delP = false;
  $("ppDel").onclick = async () => {
    if (!delP) { delP = true; $("ppDel").textContent = "Click again to delete, payslips included"; setTimeout(() => { delP = false; $("ppDel").textContent = "Delete period"; }, 4000); return; }
    delP = false; try { const files = await A.fxProofList(editingPeriod.id).catch(() => []);
      await A.deletePeriod(editingPeriod.id); A.fxProofRemove(files).catch(() => {}); $("periodDlg").close(); B.toast("Pay period deleted"); loadPayroll(); } catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- access (logins) ----------
  let users = [];
  const ROLE_LABEL = { admin: "Admin", finance: "Finance" };
  async function loadUsers() {
    if (role !== "admin") return;
    $("userRows").innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
    try { const r = await A.users(); users = r.users; meId = r.me || meId; renderUsers(); }
    catch (err) { $("userRows").innerHTML = `<tr><td colspan="4" class="muted">${B.esc(err.message)}</td></tr>`; }
  }
  const userPg = pg(20);
  function renderUsers() {
    const list = users.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));   // newest first
    const [a, b] = pager($("userPager"), list.length, userPg, renderUsers);
    $("userRows").innerHTML = list.slice(a, b).map((u) => {
      const self = u.user_id === meId;
      return `<tr><td><b>${B.esc(u.email)}</b>${self ? ` <span class="muted">(you)</span>` : ""}</td>
        <td>${self ? `<span class="pill role-${u.role}">${ROLE_LABEL[u.role]}</span>` :
          `<select data-role="${B.esc(u.user_id)}" aria-label="Role for ${B.esc(u.email)}" style="width:auto">
            ${["finance", "admin"].map((r) => `<option value="${r}" ${u.role === r ? "selected" : ""}>${ROLE_LABEL[r]}</option>`).join("")}</select>`}</td>
        <td class="mono" style="font-size:13px">${u.created_at ? B.prettyDate(u.created_at.slice(0, 10), { day: "numeric", month: "short", year: "numeric" }) : ""}</td>
        <td style="text-align:right">${self ? "" : `<button class="btn sm danger" data-remove="${B.esc(u.user_id)}">Remove</button>`}</td></tr>`;
    }).join("") || `<tr><td colspan="4" class="muted">No logins yet.</td></tr>`;
  }
  function genPassword() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
    const a = new Uint32Array(12); crypto.getRandomValues(a);
    return [...a].map((x) => chars[x % chars.length]).join("").replace(/(.{4})(.{4})(.{4})/, "$1-$2-$3");
  }
  $("uGen").onclick = () => { $("uPass").value = genPassword(); };
  $("userForm").onsubmit = async (e) => {
    e.preventDefault();
    const u = { email: $("uEmail").value.trim(), password: $("uPass").value, role: document.querySelector('input[name="uRole"]:checked').value };
    $("uSubmit").disabled = true;
    try {
      await A.createUser(u);
      $("uMadeText").textContent = `BHL Attendance (${ROLE_LABEL[u.role]})\nSign in: ${location.origin}${location.pathname}\nEmail: ${u.email.toLowerCase()}\nTemporary password: ${u.password}\nPlease change it under Access → My password after signing in.`;
      $("uMade").hidden = false; $("userForm").reset(); B.toast(`Login created for ${u.email}`); loadUsers();
    } catch (err) { B.toast(err.message, "err"); }
    $("uSubmit").disabled = false;
  };
  $("uCopy").onclick = async () => { const ok = await B.copyText($("uMadeText").textContent); B.toast(ok ? "Copied" : "Couldn't copy. Select the text instead.", ok ? "ok" : "err"); };
  $("userRows").addEventListener("change", async (e) => {
    const sel = e.target.closest("select[data-role]"); if (!sel) return;
    try { await A.updateUser({ user_id: sel.dataset.role, role: sel.value }); B.toast("Role updated"); loadUsers(); }
    catch (err) { B.toast(err.message, "err"); loadUsers(); }
  });
  let armedRemove = null;
  $("userRows").addEventListener("click", async (e) => {
    const b = e.target.closest("button[data-remove]"); if (!b) return;
    if (armedRemove !== b.dataset.remove) {
      armedRemove = b.dataset.remove; b.textContent = "Tap again to remove";
      setTimeout(() => { if (armedRemove === b.dataset.remove) { armedRemove = null; b.textContent = "Remove"; } }, 4000); return;
    }
    armedRemove = null;
    try { await A.removeUser(b.dataset.remove); B.toast("Login removed"); loadUsers(); } catch (err) { B.toast(err.message, "err"); }
  });
  $("myPwForm").onsubmit = async (e) => {
    e.preventDefault();
    if ($("myPw").value !== $("myPw2").value) return B.toast("The two passwords don't match.", "err");
    try { await A.changePassword($("myPw").value); $("myPwForm").reset(); B.toast("Password changed"); } catch (err) { B.toast(err.message, "err"); }
  };

  boot().catch((e) => B.toast(e.message, "err"));
})();
