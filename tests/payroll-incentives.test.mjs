import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBHL } from "./load.mjs";

const B = loadBHL("core.js", "schedule.js", "payroll.js");
const settings = { timezone: "Europe/London", grace_mins: 5, ot_block_mins: 30, flex_hours: true, days_per_cutoff: 10 };
const staff = { id: "s", full_name: "Test Person", sched_start: "09:00", sched_end: "18:00", lunch_mins: 60, pay_type: "bimonthly", pay_rate: 300 };
const p = { start_date: "2026-11-16", end_date: "2026-11-16" };
const row = { staff_id: "s", work_date: "2026-11-16", sched_start: "09:00", sched_end: "18:00", day_kind: "shift",
  time_in: "2026-11-16T09:00:00Z", lunch_out: "2026-11-16T12:00:00Z", lunch_in: "2026-11-16T13:00:00Z", time_out: "2026-11-16T18:00:00Z" };

test("INCENTIVES: an incentive is added to gross and net pay, with its note", () => {
  const base = B.payroll.compute(staff, [row], p, settings, {}, "2026-11-20");
  const l = B.payroll.compute(staff, [row], p, settings, { incentives: 25.5, incentive_note: "Perfect attendance" }, "2026-11-20");
  assert.equal(base.incentives, 0);
  assert.equal(l.incentives, 25.5); assert.equal(l.incentive_note, "Perfect attendance");
  assert.equal(l.basic, base.gross);
  assert.equal(l.gross, base.gross + 25.5); assert.equal(l.net, base.net + 25.5);
});

test("INCENTIVES: the payslip shows the Incentives line", () => {
  const l = B.payroll.compute(staff, [row], p, settings, { incentives: 25.5, incentive_note: "Perfect attendance" }, "2026-11-20");
  const html = B.payroll.slipHtml({ ...l, period_start: p.start_date, period_end: p.end_date, pay_date: "2026-11-25" }, "Co");
  assert.match(html, /Incentives \(Perfect attendance\)/);
  assert.match(html, /25\.50/);
});
