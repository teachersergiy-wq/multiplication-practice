import test from "node:test";
import assert from "node:assert/strict";
import { buildAddTeacherRequest, createTemporaryPasswordSlot, teacherAdminErrorMessage } from "./teacher-admin.js";

test("add teacher request trims the name and normalizes email", () => {
  assert.deepEqual(buildAddTeacherRequest({ email: "  TEACHER@SCHOOL.EDU ", fullName: "  Олена Приклад  " }), {
    email: "teacher@school.edu", fullName: "Олена Приклад",
  });
});

test("admin API errors have Ukrainian messages", () => {
  assert.match(teacherAdminErrorMessage("invalid_request"), /пошту/);
  assert.match(teacherAdminErrorMessage("forbidden"), /прав адміністратора/);
  assert.match(teacherAdminErrorMessage("conflict"), /обліковий запис/);
  assert.match(teacherAdminErrorMessage("not_found"), /не знайдено/);
  assert.equal(teacherAdminErrorMessage("internal"), null);
});

test("temporary passwords live only in the in-memory slot and clear when the dialog closes", () => {
  const slot = createTemporaryPasswordSlot();
  slot.set("synthetic-temporary-password");
  assert.equal(slot.read(), "synthetic-temporary-password");
  slot.clear();
  assert.equal(slot.read(), null);
});
