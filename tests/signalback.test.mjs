import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeConversation,
  getFindingDueDate,
  loadSampleConversation,
  loadSampleUpdateConversation,
  parseChatText,
  prioritizeFindings,
  RuleBasedAnalysisProvider,
} from "../lib/signalback.ts";

function fixtureFinding(id, category, messageId, whatChanged) {
  return {
    id,
    category,
    whatChanged,
    whatChangedBasis: "explicit",
    whyItMatters: "A test fixture explains its impact.",
    whyItMattersBasis: "inferred",
    whatToDoNext: "Check the source message.",
    whatToDoNextBasis: "inferred",
    evidence: [{ messageId }],
    reason: "Test fixture.",
  };
}

test("sample and updated sample share the parser and preserve the baseline messages", () => {
  const baseline = loadSampleConversation();
  const updated = loadSampleUpdateConversation();
  assert.equal(baseline.ok, true);
  assert.equal(updated.ok, true);
  assert.equal(baseline.conversation.format, "signalback-whatsapp-text-v1");
  assert.equal(updated.conversation.messages.length, baseline.conversation.messages.length + 1);
  assert.deepEqual(
    updated.conversation.messages.slice(0, baseline.conversation.messages.length).map(({ originalText }) => originalText),
    baseline.conversation.messages.map(({ originalText }) => originalText),
  );
});

test("dated task is represented once and due date influences priority", async () => {
  const parsed = parseChatText("2026-10-10, 09:00 - Maya: I will send the report for review by Monday, October 12.");
  assert.equal(parsed.ok, true);
  const result = await analyzeConversation(parsed.conversation.messages);
  assert.deepEqual(result.findings.map(({ category }) => category), ["task"]);
  assert.equal(result.findings[0].priority, "high");
  assert.match(result.findings[0].whatToDoNext, /Maya/);
  const due = getFindingDueDate(result.findings[0], parsed.conversation.messages);
  assert.equal(due?.getFullYear(), 2026);
  assert.equal(due?.getMonth(), 9);
  assert.equal(due?.getDate(), 12);
});

test("deadline prioritization ranks urgent items ahead and keeps blockers high", () => {
  const parsed = parseChatText([
    "2026-10-10, 09:00 - Maya: The vendor review is due October 20.",
    "2026-10-10, 09:01 - Leo: The report is due October 11.",
  ].join("\n"));
  assert.equal(parsed.ok, true);
  const [far, near] = parsed.conversation.messages;
  const ranked = prioritizeFindings([
    fixtureFinding("far", "deadline", far.id, far.originalText),
    fixtureFinding("near", "deadline", near.id, near.originalText),
    fixtureFinding("blocked", "blocker", near.id, "Finance has not sent the approved figures."),
    fixtureFinding("decision", "decision", near.id, "Agreed to keep the current plan."),
  ], parsed.conversation.messages, new Date(2026, 9, 10));
  assert.deepEqual(ranked.map(({ id }) => id), ["near", "blocked", "decision", "far"]);
  assert.equal(ranked.find(({ id }) => id === "far")?.priority, "low");
  assert.equal(ranked.find(({ id }) => id === "decision")?.priority, "medium");
});

test("sample decision action is concise and does not duplicate colon punctuation", async () => {
  const parsed = loadSampleConversation();
  assert.equal(parsed.ok, true);
  const result = await analyzeConversation(parsed.conversation.messages, new RuleBasedAnalysisProvider());
  const decision = result.findings.find(({ category }) => category === "decision");
  assert.ok(decision);
  assert.doesNotMatch(decision.whatChanged, /:\s*:/);
  assert.doesNotMatch(decision.whatToDoNext, /^Use the stated decision:/);
});

test("sample comparison yields evidence-backed findings from the updated export", async () => {
  const baseline = loadSampleConversation();
  const updated = loadSampleUpdateConversation();
  assert.equal(baseline.ok, true);
  assert.equal(updated.ok, true);
  const [before, after] = await Promise.all([
    analyzeConversation(baseline.conversation.messages),
    analyzeConversation(updated.conversation.messages),
  ]);
  assert.ok(before.findings.length > 0);
  const changedPlan = after.findings.find(({ category }) => category === "changed-plan");
  assert.ok(changedPlan);
  assert.ok(changedPlan.evidence.length > 0);
  assert.ok(changedPlan.evidence.every(({ messageId }) => updated.conversation.messages.some(({ id }) => id === messageId)));
  assert.ok(changedPlan.whatToDoNext.length > 0);
});
