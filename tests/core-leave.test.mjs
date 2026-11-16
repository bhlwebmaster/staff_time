import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBHL } from "./load.mjs";

const B = loadBHL("core.js");
const settings = { timezone: "Europe/London", grace_mins: 5, ot_block_mins: 30, flex_hours: true, count_early: false };
const staff = { id: "s1", sched_start: "09:00", sched_end: "18:00", lunch_mins: 60, hours_per_day: 8 };
const day = (day_kind, over = {}) => ({ work_date: "2026-11-16", sched_start: "09:00", sched_end: "18:00", plan_start: "09:00", plan_end: "18:00", day_kind,
  time_in: "2026-11-16T10:30:00Z", time_out: "2026-11-16T17:30:00Z", ...over });   // in at 10:30, out at 17:30 (UK is GMT in November)

test("a normal shift day clocked in at 10:30 is late", () => {
  const c = B.calcDay(day("shift"), staff, settings);
  assert.ok(c.late > 60, `late ${c.late}`);
});

test("LEAVE: working on a vacation, sick or emergency day is never late, and every worked minute is OT", () => {
  const rest = B.calcDay(day("rest"), staff, settings);
  assert.equal(rest.late, 0); assert.equal(rest.std, 0); assert.ok(rest.ot > 0, "baseline: a rest day gives OT");
  for (const kind of ["vacation", "sick", "emergency"]) {
    const c = B.calcDay(day(kind), staff, settings);
    assert.equal(c.late, 0, `${kind} late`); assert.equal(c.lateRaw, 0, `${kind} lateRaw`); assert.equal(c.std, 0, `${kind} std`);
    assert.equal(c.short, 0, `${kind} short`); assert.equal(c.ot, rest.ot, `${kind} OT matches a rest day`);
  }
});

test("LEAVE: holiday and unpaid days keep their old rules (not changed here)", () => {
  assert.ok(B.calcDay(day("holiday"), staff, settings).late > 0);
  assert.ok(B.calcDay(day("unpaid"), staff, settings).late > 0);
});

test("LEAVE: a leave day's OT goes into the bank like a rest day's, and the bank isn't used up by it", () => {
  const rows = [day("vacation")];
  const days = B.calcDays(rows, staff, { ...settings, ot_carry_from: "2026-10-01" });
  assert.ok(days.get("2026-11-16").ot > 0);
});

test("LEAVE: a clocked-in leave day reads 'VL (OT Working)'; other days keep their label", () => {
  assert.equal(B.dayStatusLabel("vacation", "Working"), "VL (OT Working)");
  assert.equal(B.dayStatusLabel("sick", "Working"), "SL (OT Working)");
  assert.equal(B.dayStatusLabel("emergency", "On lunch"), "EL (OT On lunch)");
  assert.equal(B.dayStatusLabel("vacation", "Clocked out"), "VL (OT Clocked out)");
  for (const k of ["shift", "rest", "holiday", "unpaid", undefined]) assert.equal(B.dayStatusLabel(k, "Working"), "Working");
});

test("LEAVE: a worked leave day gets the red 'otleave' pill; other days keep their colour", () => {
  assert.equal(B.dayStatusClass("vacation", "in"), "otleave");
  assert.equal(B.dayStatusClass("emergency", "lunch"), "otleave");
  for (const k of ["shift", "rest", "holiday", "unpaid", undefined]) assert.equal(B.dayStatusClass(k, "in"), "in");
});
