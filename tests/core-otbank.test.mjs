import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBHL } from "./load.mjs";

const B = loadBHL("core.js", "schedule.js", "payroll.js");
const settings = { timezone: "Europe/London", grace_mins: 5, ot_block_mins: 30, flex_hours: true, count_early: true, ot_daily_use_mins: 480, ot_bank_cap_mins: 480 };
const staff = { id: "v", sched_start: "09:00", sched_end: "18:00", lunch_mins: 60, ot_carry_from: "2026-01-01", pay_type: "bimonthly", pay_rate: 300 };
// 9:00 of OT banked on Fri 13 Nov (09:00–03:00 next day with an hour's lunch = 17:00 worked, 8:00 expected → 9:00 OT)
const otDay = { work_date: "2026-11-13", sched_start: "09:00", sched_end: "18:00", plan_start: "09:00", plan_end: "18:00", day_kind: "shift",
  time_in: "2026-11-13T09:00:00Z", lunch_out: "2026-11-13T12:00:00Z", lunch_in: "2026-11-13T13:00:00Z", time_out: "2026-11-14T03:00:00Z" };
const bankDay = { work_date: "2026-11-16", sched_start: "09:00", sched_end: "18:00", plan_start: "09:00", plan_end: "18:00", day_kind: "otbank" };

test("OT BANK DAY: no clock-in, the whole expected shift (8:00) comes from the bank", () => {
  const m = B.calcDays([otDay, bankDay], staff, settings), c = m.get("2026-11-16");
  assert.equal(c.complete, true); assert.equal(c.worked, 0); assert.equal(c.std, 480);
  assert.equal(c.otUsed, 480); assert.equal(c.short, 0); assert.equal(c.late, 0);
  assert.equal(m.bank, 60, "1:00 left of 9:00");
});

test("OT BANK DAY: a bank too small leaves the rest as short time", () => {
  const small = { ...otDay, time_out: "2026-11-13T21:00:00Z" };   // 11:00 worked → 3:00 OT
  const c = B.calcDays([small, bankDay], staff, settings).get("2026-11-16");
  assert.equal(c.otUsed, 180); assert.equal(c.short, 300);
});

test("OT BANK DAY: payroll counts it as a paid day, not an absence", () => {
  const plan = (d) => (d === "2026-11-16" ? { kind: "otbank" } : ["2026-11-14", "2026-11-15"].includes(d) ? { kind: "rest" } : { kind: "shift" });
  const rows = [otDay, bankDay].map((r) => ({ ...r, staff_id: "v" }));
  const p = { start_date: "2026-11-13", end_date: "2026-11-16" };
  const l = B.payroll.compute(staff, rows, p, settings, {}, "2026-11-20", plan);
  assert.equal(l.absences, 0); assert.equal(l.undertime_mins, 0); assert.equal(l.days_worked, 2);
});

test("COVER: start later 3:00 keeps the planned 9–6 day; 3:00 comes from the bank", () => {
  const day = { work_date: "2026-11-16", sched_start: "12:00", sched_end: "18:00", plan_start: "09:00", plan_end: "18:00", day_kind: "shift",
    time_in: "2026-11-16T12:00:00Z", lunch_out: "2026-11-16T14:00:00Z", lunch_in: "2026-11-16T14:30:00Z", time_out: "2026-11-16T18:00:00Z" };
  const c = B.calcDays([otDay, day], staff, settings).get("2026-11-16");
  assert.equal(c.late, 0); assert.equal(c.std, 480); assert.equal(c.otUsed, 480 - c.worked);
  assert.equal(B.bankPlanned(day), 180);
});

test("SCHEDULE: a cover and an OT bank day show on the schedule", () => {
  const S = B.sched, p = { id: "v", sched_start: "09:00", sched_end: "18:00" };
  const ov = S.indexDays([{ staff_id: "v", work_date: "2026-11-16", kind: "shift", start_time: "09:00", end_time: "18:00", cover_mins: 180, cover_side: "start" },
                          { staff_id: "v", work_date: "2026-11-17", kind: "otbank", start_time: "09:00", end_time: "18:00" }]);
  const a = S.effective(p, "2026-11-16", ov), b = S.effective(p, "2026-11-17", ov);
  assert.equal(a.cover, 180); assert.equal(a.side, "start"); assert.equal(a.start, "09:00"); assert.equal(a.end, "18:00");
  assert.equal(b.kind, "otbank"); assert.equal(S.KINDS.otbank.label, "OT Bank Day");
  assert.match(S.timelineHtml("2026-11-15", [p], ov, "2026-11-16"), /class="cov/);
});

test("WHATSAPP: shows the planned hours and the OT bank cover until clock-out", () => {
  const row = { work_date: "2026-11-16", sched_start: "12:00", sched_end: "18:00", plan_start: "09:00", plan_end: "18:00", time_in: "2026-11-16T12:00:00Z" };
  const t = B.whatsappText(row, { full_name: "GAMOTAN, VERGILIO JR." }, settings);
  assert.match(t, /Sched: 9:00 AM - 6:00 PM GMT/); assert.match(t, /OT bank: 3:00 \(start later\)/);
  const done = B.whatsappText({ ...row, time_out: "2026-11-16T18:00:00Z" }, { full_name: "X" }, settings, [], 180);
  assert.doesNotMatch(done, /OT bank:/); assert.match(done, /OT used: 3:00/);
});

test("SCHEDULE CELL: planned hours, then the new schedule with the OT bank offset", () => {
  const S = B.sched;
  const late = S.cellHtml({ kind: "shift", start: "06:00", end: "15:00", cover: 180, side: "end" });
  assert.match(late, /6:00AM-3:00PM/);
  assert.match(late, /New Schedule: 6:00AM - 12:00PM \(3:00 OT Bank Offset Usage\)/);
  const early = S.cellHtml({ kind: "shift", start: "09:00", end: "18:00", cover: 90, side: "start" });
  assert.match(early, /New Schedule: 10:30AM - 6:00PM \(1:30 OT Bank Offset Usage\)/);
  assert.doesNotMatch(S.cellHtml({ kind: "shift", start: "09:00", end: "18:00", cover: 0 }), /New Schedule/);
});

test("TEAM TODAY: working hours are adjusted by the OT bank cover", () => {
  const S = B.sched;
  assert.equal(S.workRange({ kind: "shift", start: "06:00", end: "15:00", cover: 180, side: "end" }).join("-"), ["06:00", "12:00"].join("-"));
  assert.equal(S.workRange({ kind: "shift", start: "09:00", end: "18:00", cover: 120, side: "start" }).join("-"), ["11:00", "18:00"].join("-"));
  assert.equal(S.workRange({ kind: "shift", start: "09:00", end: "18:00", cover: 0 }).join("-"), ["09:00", "18:00"].join("-"));
});
