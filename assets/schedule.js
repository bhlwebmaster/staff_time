/* Weekly schedule: effective day plans, week table and hour-by-hour timeline. Shared by staff and admin pages. */
(function () {
  const B = window.BHL;
  const KINDS = {
    shift:    { label: "Shift" },
    rest:     { label: "Rest Day", cls: "k-rest" },
    vacation: { label: "Vacation Leave", cls: "k-vac", paid: true },
    sick:     { label: "Sick Leave", cls: "k-sick", paid: true },
    holiday:  { label: "Holiday", cls: "k-hol", paid: true },
    unpaid:   { label: "Unpaid Leave", cls: "k-unpaid" },
  };
  const DAY = ["SUNDAY", "MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY"];
  const addDays = (ds, n) => { const d = new Date(ds + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const dow = (ds) => new Date(ds + "T12:00:00Z").getUTCDay();
  /** Sunday of the week containing ds (weeks run Sunday → Saturday, like the WhatsApp schedule). */
  const weekStart = (ds) => addDays(ds, -dow(ds));
  const hhmm = (t) => (t ? String(t).slice(0, 5) : "");
  const mins = (t) => { const [h, m] = hhmm(t).split(":").map(Number); return h * 60 + m; };
  const ampm = (t) => { let [h, m] = hhmm(t).split(":").map(Number); const ap = h >= 12 ? "PM" : "AM"; h = h % 12 || 12; return `${h}:${String(m).padStart(2, "0")}${ap}`; };

  /** The usual shift for a weekday from the person's pattern (or Mon–Fri default). */
  function patternDay(p, d) {
    if (p.week_pattern) { const x = p.week_pattern[String(d)]; return x ? { kind: "shift", start: x.s, end: x.e } : { kind: "rest" }; }
    return d === 0 || d === 6 ? { kind: "rest" } : { kind: "shift", start: hhmm(p.sched_start), end: hhmm(p.sched_end) };
  }
  /** What a person is planned to do on a date: a changed day wins over their usual week. */
  function effective(p, ds, overrides) {
    const o = overrides && overrides[p.id + "|" + ds];
    if (o) return { kind: o.kind, start: hhmm(o.start_time) || patternDay(p, dow(ds)).start || hhmm(p.sched_start), end: hhmm(o.end_time) || patternDay(p, dow(ds)).end || hhmm(p.sched_end), note: o.note, changed: true };
    return { ...patternDay(p, dow(ds)), changed: false };
  }
  const indexDays = (list) => { const m = {}; for (const d of list || []) m[d.staff_id + "|" + d.work_date] = d; return m; };

  function cellText(e) { return e.kind === "shift" ? `${ampm(e.start)}-${ampm(e.end)}` : KINDS[e.kind]?.label || e.kind; }

  /** Bottom table in the WhatsApp sheet: one row per person, one column per day. */
  function tableHtml(from, people, overrides, today) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    return `<table class="wk-table"><thead><tr><th>UK time</th>${days.map((d) => `<th class="${d === today ? "is-today" : ""}">${DAY[dow(d)]}<span>${+d.slice(8)}</span></th>`).join("")}</tr></thead>
      <tbody>${people.map((p) => `<tr><th style="--pc:${B.colorOf ? B.colorOf(p) : "#0d7656"}"><span class="dot"></span>${B.esc(p.display_name)}</th>${days.map((d) => {
        const e = effective(p, d, overrides);
        return `<td class="${KINDS[e.kind]?.cls || ""} ${d === today ? "is-today" : ""}" title="${B.esc(e.note || "")}">${cellText(e)}</td>`; }).join("")}</tr>`).join("")}</tbody></table>`;
  }

  /** Top grid in the WhatsApp sheet: who's on, hour by hour. Same group of people across hours = one merged block. */
  function timelineHtml(from, people, overrides, today) {
    const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
    const on = days.map((d) => Array.from({ length: 24 }, (_, h) => people.filter((p) => {
      const e = effective(p, d, overrides); if (e.kind !== "shift" || !e.start || !e.end) return false;
      let s = mins(e.start), en = mins(e.end); if (en <= s) en = 24 * 60; // overnight: show to midnight
      return h * 60 < en && (h + 1) * 60 > s;
    }).map((p) => p.display_name)));
    const palette = ["#d9f2f0", "#39e3ec", "#c9f1d9", "#fde7c2", "#f8d5d0", "#d6e4f6", "#f6c64a", "#e7dcf7", "#cfe9b8", "#ffd9ec"];
    const colorFor = {}; let ci = 0;
    const col = (key) => (colorFor[key] ||= palette[ci++ % palette.length]);
    let html = `<table class="wk-time"><thead><tr><th>UK time</th>${days.map((d) => `<th class="${d === today ? "is-today" : ""}">${DAY[dow(d)].slice(0, 3)}<span>${+d.slice(8)}</span></th>`).join("")}</tr></thead><tbody>`;
    const skip = days.map(() => 0);
    for (let h = 0; h < 24; h++) {
      const lab = new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
      html += `<tr><th>${lab}</th>`;
      days.forEach((d, i) => {
        if (skip[i] > 0) { skip[i]--; return; }
        const names = on[i][h], key = names.join(", ");
        let span = 1; while (h + span < 24 && on[i][h + span].join(", ") === key) span++;
        skip[i] = span - 1;
        html += names.length ? `<td rowspan="${span}" class="blk" style="background:${col(key)}"><span>${B.esc(key)}</span></td>` : `<td rowspan="${span}"></td>`;
      });
      html += `</tr>`;
    }
    return html + `</tbody></table>`;
  }

  const CSS = `
  .wk-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
  .wk-table, .wk-time { border-collapse: collapse; width: 100%; font-size: 12.5px; min-width: 640px; }
  .wk-table th, .wk-table td, .wk-time th, .wk-time td { border: 1px solid #d5dedb; padding: 6px 6px; text-align: center; }
  .wk-table thead th, .wk-time thead th { background: #0f5c56; color: #fff; font-size: 11px; letter-spacing: .04em; }
  .wk-table thead th span, .wk-time thead th span { display: block; font-size: 13px; }
  .wk-table thead th.is-today, .wk-time thead th.is-today { background: #0a3f3b; box-shadow: inset 0 -3px #ffe45c; }
  .wk-table tbody th { text-align: left; white-space: nowrap; font-weight: 700; color: var(--ink); background: var(--surface); }
  .wk-table tbody th .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; background: var(--pc); margin-right: 6px; }
  .wk-table td { white-space: nowrap; font-family: var(--mono); font-size: 11.5px; color: var(--ink); }
  .wk-table td.is-today { box-shadow: inset 0 0 0 2px #ffe45c; }
  .wk-table td.k-rest, .wk-time td.k-rest { background: #fff59a; color: #3b3500; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-vac { background: #37d34a; color: #06300c; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-sick { background: #ffc9b8; color: #4a1606; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-hol { background: #b9d8ff; color: #0b2a52; font-family: var(--body); font-weight: 700; }
  .wk-table td.k-unpaid { background: #e4e4e4; color: #333; font-family: var(--body); font-weight: 700; }
  .wk-time { table-layout: fixed; } .wk-time thead th:first-child { width: 78px; }
  .wk-time tbody th { font-size: 11px; font-weight: 600; white-space: nowrap; color: var(--muted); background: var(--surface); width: 72px; }
  .wk-time td { height: 22px; padding: 0 4px; }
  .wk-time td.blk { color: #10302c; font-weight: 600; font-size: 12px; }
  .wk-legend { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; color: var(--muted); margin-top: 8px; }
  .wk-legend i { display: inline-block; width: 12px; height: 12px; border-radius: 3px; vertical-align: -2px; margin-right: 4px; }`;

  Object.assign(B, { sched: { KINDS, DAY, addDays, dow, weekStart, effective, patternDay, indexDays, tableHtml, timelineHtml, cellText, hhmm, ampm, CSS } });
})();
