import assert from "node:assert/strict";
import test from "node:test";
import { competitiveApiMessage, competitiveRemainingSeconds, formatCompetitiveDuration, publishChoices, qualifiedLabels, updateQuestionClock } from "./competitive-flow.js";

test("competitive countdown uses the server issue time and client elapsed time", () => {
  const serverNow = "2026-10-28T10:00:00.000Z";
  assert.equal(competitiveRemainingSeconds(8000, serverNow, 1000, 3500), 6);
  assert.equal(competitiveRemainingSeconds(8000, serverNow, 1000, 9500), 0);
});

test("duration and qualified ranking labels are formatted for students", () => {
  assert.equal(formatCompetitiveDuration(125900), "2:05");
  assert.deepEqual(qualifiedLabels([{ scope: "class", rank: 2 }, { scope: "school", rank: 4 }]).map((x) => x.label), ["клас", "школа"]);
});

test("publication choices default to none and allow name only for class qualification", () => {
  assert.deepEqual(publishChoices([]), ["none"]);
  assert.deepEqual(publishChoices([{ scope: "school", rank: 1 }]), ["none", "nickname", "anonymous"]);
  assert.ok(publishChoices([{ scope: "class", rank: 1 }]).includes("name"));
});

test("API errors are localized and rate-limited responses are silent", () => {
  assert.equal(competitiveApiMessage("rate_limited"), "");
  assert.match(competitiveApiMessage("forbidden"), /закритий/);
  assert.match(competitiveApiMessage("anything"), /екрані/);
});

test("next-question timer starts from its response time with the corrected clock", () => {
  const next = updateQuestionClock({ serverNow: "2026-10-28T10:00:00.000Z", receivedAt: 1000 }, 7700, 3500);
  assert.equal(next.serverNow, "2026-10-28T10:00:02.500Z");
  assert.equal(competitiveRemainingSeconds(next.limitMs, next.serverNow, next.receivedAt, 4500), 7);
});
