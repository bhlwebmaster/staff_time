(function () {
  const B = window.BHL, api = B.api, A = api.admin;
  const $ = (id) => document.getElementById(id);
  let settings = null, staff = [], sheetRows = [], editing = null, editingStaff = null, role = null, meId = null;
  const TABS = () => role === "admin" ? ["today", "sheets", "reports", "staff", "settings", "access"] : ["today", "sheets", "reports", "access"];
  const tz = () => settings?.timezone || "Europe/London";
  const byId = (id) => staff.find((s) => s.id === id);
  const today = () => B.dateIn(new Date(), tz());
  const t = (iso) => (iso ? B.clockIn(new Date(iso), tz()) : "—");
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const friendly = (e) => /duplicate|unique/i.test(e.message) ? "There is already an entry for that person on that date." : e.message;

  // ---------- auth ----------
  async function boot() {
    $("demoBanner").hidden = !api.demo;
    const session = await A.session();
    if (!session) return showLogin();
    role = await A.role().catch(() => null);
    if (!role) { await A.signOut(); return showLogin("This login doesn't have access. Ask an admin to add you under Access."); }
    document.body.classList.toggle("ro", role !== "admin");
    const me = await A.me().catch(() => null); meId = me?.id; $("meEmail").textContent = me?.email || "";
    $("vLogin").hidden = true; $("tabs").hidden = false; $("signOut").hidden = false;
    settings = await A.settings();
    staff = await A.staff();
    fillPeople();
    setRange("tm");
    $("dayPick").value = today();
    $("rDay").value = today(); $("rMonth").value = today().slice(0, 7); $("rFrom").value = today().slice(0, 8) + "01"; $("rTo").value = today();
    const tab = (location.hash || "#today").slice(1);
    openTab(TABS().includes(tab) ? tab : "today");
    tick(); setInterval(tick, 10000);
    setInterval(() => { if (!document.hidden && !$("tab-today").hidden && $("dayPick").value === today()) loadDay(); }, 60000);
  }
  function showLogin(msg) { $("vLogin").hidden = false; $("lMsg").textContent = msg || ""; }
  $("loginForm").onsubmit = async (e) => {
    e.preventDefault(); $("lMsg").textContent = "Signing in…";
    try { await A.signIn($("lEmail").value.trim(), $("lPass").value); api.demo ? boot() : location.reload(); }
    catch (err) { $("lMsg").textContent = err.message; }
  };
  $("signOut").onclick = async () => { await A.signOut(); location.reload(); };
  function tick() { $("ukClock").textContent = B.clockIn(new Date(), tz()); }

  // ---------- tabs ----------
  function openTab(name) {
    for (const b of $("tabs").children) b.setAttribute("aria-selected", b.dataset.tab === name);
    if (!TABS().includes(name)) name = "today";
    for (const n of ["today", "sheets", "reports", "staff", "settings", "access"]) $("tab-" + n).hidden = n !== name;
    history.replaceState(null, "", "#" + name);
    ({ today: loadDay, sheets: loadSheets, staff: renderStaff, settings: renderSettings, access: loadUsers, reports: loadReport })[name]();
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
    if (c.short) f.push(`<span class="flag short">Short ${B.fmtMins(c.short)}</span>`);
    if (c.open && !isToday) f.push(`<span class="flag miss">No clock-out</span>`);
    return f.join(" ");
  }
  const lunchCell = (r) => r.lunch_out ? `${t(r.lunch_out)}–${r.lunch_in ? t(r.lunch_in) : "…"}` : "—";
  const pillFor = (c) => ({ in: ["in", "Working"], lunch: ["lunch", "On lunch"], out: ["out", "Clocked out"], absent: ["absent", "Not in"] }[c.status]);

  // ---------- today ----------
  async function loadDay() {
    const day = $("dayPick").value || today();
    $("dayTitle").textContent = day === today() ? "Today · " + B.prettyDate(day) : B.prettyDate(day, { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const rows = await A.attendance(day, day);
    const act = staff.filter((s) => s.active || rows.some((r) => r.staff_id === s.id));
    let n = { in: 0, lunch: 0, out: 0, absent: 0, late: 0 };
    $("dayRows").innerHTML = act.map((s) => {
      const r = rows.find((x) => x.staff_id === s.id);
      const c = r ? B.calcDay(r, s, settings) : { status: "absent" };
      n[c.status]++; if (c.late) n.late++;
      const [k, label] = pillFor(c);
      let worked = "—";
      if (c.worked != null) worked = B.fmtMins(c.worked);
      else if (r?.time_in && day === today()) {
        const lunch = r.lunch_out ? ((r.lunch_in ? new Date(r.lunch_in) : new Date()) - new Date(r.lunch_out)) : 0;
        worked = `<span class="muted">${B.fmtMins(Math.max(0, (Date.now() - Math.max(new Date(r.time_in), c.schedStart) - lunch) / 60000))}</span>`;
      }
      return `<tr><td><b>${B.esc(s.display_name)}</b></td><td><span class="pill ${k}">${label}</span></td>
        <td class="mono">${B.clockStr(r?.sched_start || s.sched_start)}–${B.clockStr(r?.sched_end || s.sched_end)}</td>
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
  $("who").onchange = () => renderSheets();

  async function loadSheets() {
    sheetRows = await A.attendance($("from").value, $("to").value);
    renderSheets();
  }
  function computeSheets() {
    const who = $("who").value;
    const people = staff.filter((s) => (!who || s.id === who) && (s.active || sheetRows.some((r) => r.staff_id === s.id)));
    return people.map((s) => ({ s, sum: B.summarise(sheetRows.filter((r) => r.staff_id === s.id), s, settings, today()) }));
  }
  function renderSheets() {
    const list = computeSheets();
    const period = `${B.prettyDate($("from").value, { day: "numeric", month: "short", year: "numeric" })} – ${B.prettyDate($("to").value, { day: "numeric", month: "short", year: "numeric" })}`;
    $("sheetTitle").textContent = period;
    $("printTitle").textContent = `${settings.company_name} · Timesheet · ${period}`;
    const tot = list.reduce((a, { sum }) => { for (const k of ["days", "worked", "regular", "ot", "short", "bank", "late", "missingOut", "billable"]) a[k] = (a[k] || 0) + sum[k]; return a; }, {});
    $("sheetKpis").innerHTML = [
      [B.hoursDec(tot.billable || 0), "billable hours"], [tot.days || 0, "days worked"],
      [B.fmtMins(tot.ot || 0), "OT earned (h:mm)"], [tot.late || 0, "late arrivals", tot.late], [tot.missingOut || 0, "missing clock-outs", tot.missingOut],
    ].map(([v, l, w]) => `<div class="card kpi ${w ? "warn" : ""}"><b>${v}</b><span>${l}</span></div>`).join("");
    const cells = (x) => `<td class="num">${x.days}</td><td class="num">${B.fmtMins(x.worked)}</td><td class="num">${B.fmtMins(x.regular)}</td>
      <td class="num">${B.fmtMins(x.ot)}</td><td class="num">${B.fmtMins(x.short)}</td>
      <td class="num" style="color:${x.bank < 0 ? "var(--late)" : x.bank > 0 ? "var(--accent)" : "inherit"}">${B.fmtMins(x.bank, { sign: true })}</td>
      <td class="num">${x.late}</td><td class="num" style="${x.missingOut ? "color:var(--late)" : ""}">${x.missingOut}</td><td class="num"><b>${B.hoursDec(x.billable)}</b></td>`;
    $("sumRows").innerHTML = list.map(({ s, sum }) => `<tr class="click ${$("who").value === s.id ? "sel" : ""}" data-id="${B.esc(s.id)}"><td><b>${B.esc(s.display_name)}</b><span class="sub">${B.esc(s.full_name)}</span></td>${cells(sum)}</tr>`).join("")
      || `<tr><td colspan="10" class="muted">No entries in this period.</td></tr>`;
    $("sumFoot").innerHTML = list.length > 1 ? `<tr><td>Total</td>${cells(tot)}</tr>` : "";
    const days = list.flatMap(({ s, sum }) => sum.days_list.map((x) => ({ s, ...x }))).sort((a, b) => b.row.work_date.localeCompare(a.row.work_date) || a.s.display_name.localeCompare(b.s.display_name));
    $("dailyRows").innerHTML = days.map(({ s, row: r, c }) => `<tr>
      <td class="mono">${B.prettyDate(r.work_date)}</td><td>${B.esc(s.display_name)}</td>
      <td class="mono">${B.clockStr(r.sched_start)}–${B.clockStr(r.sched_end)}</td>
      <td class="mono">${t(r.time_in)}</td><td class="mono">${lunchCell(r)}</td><td class="mono">${t(r.time_out)}</td>
      <td class="num">${c.worked != null ? B.fmtMins(c.worked) : "—"}</td><td>${flagsHtml(c, r.work_date === today())}</td>
      <td class="note">${B.esc(r.note || "")}</td><td class="noprint"><button class="btn sm adminonly" data-edit="${B.esc(r.id)}">Edit</button></td></tr>`).join("")
      || `<tr><td colspan="10" class="muted">No entries.</td></tr>`;
  }
  $("sumRows").onclick = (e) => { const tr = e.target.closest("tr[data-id]"); if (!tr) return; $("who").value = $("who").value === tr.dataset.id ? "" : tr.dataset.id; renderSheets(); };
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
    ["Name", "Timesheet name", "Period from", "Period to", "Days worked", "Worked hours", "Regular hours", "OT earned hours", "Offset/short hours", "OT bank hours", "Late arrivals", "Late minutes", "Missing clock-outs", "Billable hours"],
    ...computeSheets().map(({ s, sum }) => [s.display_name, s.full_name, $("from").value, $("to").value, sum.days, B.hoursDec(sum.worked), B.hoursDec(sum.regular),
      B.hoursDec(sum.ot), B.hoursDec(sum.short), B.hoursDec(sum.bank), sum.late, sum.lateMins, sum.missingOut, B.hoursDec(sum.billable)]),
  ]);
  $("csvDay").onclick = () => download(`BHL-timesheet-daily_${period()}.csv`, [
    ["Date", "Name", "Timesheet name", "Sched start (UK)", "Sched end (UK)", "Time in (UK)", "Lunch out", "Lunch in", "Time out (UK)", "Worked hours", "Late minutes", "OT earned minutes", "Short minutes", "Note"],
    ...computeSheets().flatMap(({ s, sum }) => sum.days_list.map(({ row: r, c }) => [r.work_date, s.display_name, s.full_name, r.sched_start.slice(0, 5), r.sched_end.slice(0, 5),
      B.hhmmIn(c.tin, tz()), B.hhmmIn(c.lo, tz()), B.hhmmIn(c.li, tz()), B.hhmmIn(c.tout, tz()), c.worked != null ? B.hoursDec(c.worked) : "", c.late, c.ot, c.short, r.note || ""])),
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
    $("eDel").hidden = !r;
    $("eHist").innerHTML = "";
    $("entryDlg").showModal();
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
      time_in: iso($("eIn").value), lunch_out: iso($("eLO").value), lunch_in: iso($("eLI").value), time_out: iso($("eOut").value), note: $("eNote").value.trim() || null };
    const seq = [rec.time_in, rec.lunch_out, rec.lunch_in, rec.time_out].filter(Boolean);
    if (seq.some((v, i) => i && v < seq[i - 1])) return B.toast("Times must run in order: in → lunch out → lunch in → out.", "err");
    if (rec.sched_end <= rec.sched_start) return B.toast("Schedule end must be after start.", "err");
    try {
      await A.saveAttendance(editing ? { ...rec, id: editing.id } : rec);
      $("entryDlg").close(); B.toast("Saved"); refresh();
    } catch (err) { B.toast(friendly(err), "err"); }
  };
  let delArmed = false;
  $("eDel").onclick = async () => {
    if (!delArmed) { delArmed = true; $("eDel").textContent = "Tap again to delete"; setTimeout(() => { delArmed = false; $("eDel").textContent = "Delete entry"; }, 4000); return; }
    delArmed = false; $("eDel").textContent = "Delete entry";
    try { await A.deleteAttendance(editing.id); $("entryDlg").close(); B.toast("Entry deleted"); refresh(); } catch (err) { B.toast(err.message, "err"); }
  };
  function refresh() { if (!$("tab-today").hidden) loadDay(); if (!$("tab-sheets").hidden) loadSheets(); }

  // ---------- staff ----------
  function renderStaff() {
    $("staffRows").innerHTML = staff.map((s) => `<tr>
      <td><b>${B.esc(s.display_name)}</b></td><td>${B.esc(s.full_name)}</td>
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
    $("pReset").hidden = !s?.has_pin;
    $("staffDlg").showModal();
  }
  $("staffForm").onsubmit = async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    const rec = { display_name: $("pDisp").value.trim(), full_name: $("pFull").value.trim().toUpperCase(), sched_start: $("pSS").value, sched_end: $("pSE").value,
      lunch_mins: +$("pLunch").value, active: $("pActive").value === "true" };
    if (rec.sched_end <= rec.sched_start) return B.toast("End must be after start.", "err");
    try {
      await A.saveStaff(editingStaff ? { ...rec, id: editingStaff.id } : rec);
      staff = await A.staff(); fillPeople(); renderStaff(); $("staffDlg").close(); B.toast("Saved");
    } catch (err) { B.toast(err.message, "err"); }
  };
  $("pReset").onclick = async () => {
    try { await A.resetPin(editingStaff.id); staff = await A.staff(); renderStaff(); $("pReset").hidden = true; B.toast(`PIN cleared for ${editingStaff.display_name}`); }
    catch (err) { B.toast(err.message, "err"); }
  };

  // ---------- settings ----------
  function renderSettings() {
    $("stCompany").value = settings.company_name; $("stTz").value = settings.timezone;
    $("stGrace").value = settings.grace_mins; $("stBlock").value = settings.ot_block_mins; $("stEarly").checked = settings.count_early;
  }
  $("setForm").onsubmit = async (e) => {
    e.preventDefault();
    const s = { company_name: $("stCompany").value.trim(), timezone: $("stTz").value, grace_mins: +$("stGrace").value,
      ot_block_mins: Math.max(1, +$("stBlock").value), count_early: $("stEarly").checked };
    try { await A.saveSettings(s); settings = { ...settings, ...s }; B.toast("Settings saved"); } catch (err) { B.toast(err.message, "err"); }
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
  $("rWho").onchange = () => renderReport();
  function step(n) {
    if (rType === "day") $("rDay").value = addDays($("rDay").value || today(), n);
    if (rType === "week") $("rDay").value = addDays($("rDay").value || today(), 7 * n);
    if (rType === "month") { const d = new Date(($("rMonth").value || today().slice(0, 7)) + "-15T12:00:00Z"); d.setUTCMonth(d.getUTCMonth() + n); $("rMonth").value = d.toISOString().slice(0, 7); }
    loadReport();
  }
  $("rPrev").onclick = () => step(-1); $("rNext").onclick = () => step(1);
  $("rNow").onclick = () => { $("rDay").value = today(); $("rMonth").value = today().slice(0, 7); loadReport(); };

  async function loadReport() {
    const R = reportRange();
    const rows = await A.attendance(R.from, R.to);
    report = { R, rows };
    renderReport();
  }
  function buildReport() {
    const { R, rows } = report, who = $("rWho").value;
    const cols = buckets(R.from, R.to);
    const people = staff.filter((s) => (!who || s.id === who) && (s.active || rows.some((r) => r.staff_id === s.id)));
    const lines = people.map((s) => {
      const mine = rows.filter((r) => r.staff_id === s.id);
      const sum = B.summarise(mine, s, settings, today());
      const cells = cols.map((c) => sum.days_list.filter((x) => x.row.work_date >= c.from && x.row.work_date <= c.to && x.c.complete).reduce((a, x) => a + x.c.worked, 0));
      const has = cols.map((c) => sum.days_list.some((x) => x.row.work_date >= c.from && x.row.work_date <= c.to && x.c.tin));
      return { s, sum, cells, has };
    });
    const tot = lines.reduce((a, l) => { for (const k of ["days", "worked", "regular", "ot", "short", "bank", "late", "missingOut", "billable"]) a[k] = (a[k] || 0) + l.sum[k]; return a; }, {});
    const colTot = cols.map((_, i) => lines.reduce((a, l) => a + l.cells[i], 0));
    const detail = lines.flatMap((l) => l.sum.days_list.map((x) => ({ s: l.s, ...x }))).sort((a, b) => a.row.work_date.localeCompare(b.row.work_date) || a.s.display_name.localeCompare(b.s.display_name));
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
    $("matrix").innerHTML = `<thead><tr><th>Name</th>${showCols ? cols.map((c) => `<th class="num">${c.label}<span class="d">${c.sub}</span></th>`).join("") : ""}
        <th class="num tot">Worked</th><th class="num">Regular</th><th class="num">OT</th><th class="num">Short</th><th class="num">Late</th><th class="num tot">Billable hrs</th></tr></thead>
      <tbody>${lines.map((l) => `<tr><td><b>${B.esc(l.s.display_name)}</b><span class="sub">${B.esc(l.s.full_name)}</span></td>
        ${showCols ? l.cells.map((m, i) => cell(m, l.has[i])).join("") : ""}
        <td class="num tot"><b>${B.fmtMins(l.sum.worked)}</b></td><td class="num">${B.fmtMins(l.sum.regular)}</td><td class="num">${B.fmtMins(l.sum.ot)}</td>
        <td class="num">${B.fmtMins(l.sum.short)}</td><td class="num">${l.sum.late}</td><td class="num tot"><b>${B.hoursDec(l.sum.billable)}</b></td></tr>`).join("")
        || `<tr><td colspan="${cols.length + 7}" class="muted">No staff match this filter.</td></tr>`}</tbody>
      ${lines.length > 1 ? `<tfoot><tr><td>Total</td>${showCols ? colTot.map((m) => `<td class="num">${B.fmtMins(m)}</td>`).join("") : ""}
        <td class="num tot">${B.fmtMins(tot.worked)}</td><td class="num">${B.fmtMins(tot.regular)}</td><td class="num">${B.fmtMins(tot.ot)}</td>
        <td class="num">${B.fmtMins(tot.short)}</td><td class="num">${tot.late}</td><td class="num tot">${B.hoursDec(tot.billable)}</td></tr></tfoot>` : ""}`;
    $("repDetail").innerHTML = `<thead><tr><th>Date</th><th>Name</th><th>Schedule</th><th>In</th><th>Lunch</th><th>Out</th><th class="num">Worked</th><th>Flags</th><th>Note</th></tr></thead>
      <tbody>${X.detail.map(({ s, row: r, c }) => `<tr><td class="mono">${B.prettyDate(r.work_date)}</td><td>${B.esc(s.display_name)}</td>
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

  // ---------- access (logins) ----------
  let users = [];
  const ROLE_LABEL = { admin: "Admin", finance: "Finance" };
  async function loadUsers() {
    if (role !== "admin") return;
    $("userRows").innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;
    try { const r = await A.users(); users = r.users; meId = r.me || meId; renderUsers(); }
    catch (err) { $("userRows").innerHTML = `<tr><td colspan="4" class="muted">${B.esc(err.message)}</td></tr>`; }
  }
  function renderUsers() {
    $("userRows").innerHTML = users.map((u) => {
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
