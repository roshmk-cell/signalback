import type {
  ClaimBasis,
  ChatMessage,
  Finding,
  FindingCategory,
  ParsedConversation,
} from "@/lib/signalback";

export const MEMORY_STORAGE_KEY = "signalback.memory.v1";
export const MEMORY_SCHEMA_VERSION = 1;

export type FindingStatus = "new" | "in-progress" | "completed" | "blocked";
export type TimelineKind = FindingCategory | "still-open";

export interface SavedFinding {
  finding: Finding;
  provider: string;
  status: FindingStatus;
  reviewed: boolean;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineKind;
  whatChanged: string;
  whyItMatters: string;
  whatToDoNext: string;
  basis: ClaimBasis;
  evidenceMessageIds: string[];
  findingId: string;
  sortTime?: number;
  sourceOrder: number;
}

export interface SavedConversationMemory {
  schemaVersion: typeof MEMORY_SCHEMA_VERSION;
  conversationId: string;
  messages: ChatMessage[];
  findings: SavedFinding[];
  timeline: TimelineEvent[];
  dismissedTimelineIds: string[];
  firstImportedAt: string;
  lastImportedAt: string;
  lastAnalyzedAt: string;
  lastProvider: string;
  lastNewMessageCount: number;
  comparisonCount: number;
}

export type ImportMatch = "same" | "uncertain";

function hash(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${(first >>> 0).toString(36)}${(second >>> 0).toString(36)}`;
}

function normalizedPart(value: string | undefined): string {
  return (value ?? "").normalize("NFC").replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

export function messageFingerprint(message: ChatMessage): string {
  const timestamp = message.timestamp
    ? new Date(message.timestamp).toISOString()
    : normalizedPart(message.timestampText);
  return [timestamp, normalizedPart(message.sender), normalizedPart(message.originalText)].join("\u001f");
}

/** Replace position-based parser IDs with stable IDs while preserving source order and text. */
export function stabilizeConversation(conversation: ParsedConversation): ParsedConversation {
  const duplicateCounts = new Map<string, number>();
  const messages = conversation.messages.map((message, sourceOrder) => {
    const fingerprint = messageFingerprint(message);
    const occurrence = duplicateCounts.get(fingerprint) ?? 0;
    duplicateCounts.set(fingerprint, occurrence + 1);
    return {
      ...message,
      id: `msg-${hash(fingerprint)}${occurrence ? `-${occurrence + 1}` : ""}`,
      sourceOrder,
    };
  });
  return { ...conversation, messages };
}

/** A positive match is deliberately conservative; ambiguous imports require a user choice. */
export function matchImport(
  saved: SavedConversationMemory,
  incoming: ParsedConversation,
): ImportMatch {
  const baseline = new Set(saved.messages.map(messageFingerprint));
  const next = new Set(incoming.messages.map(messageFingerprint));
  if (baseline.size === next.size && [...baseline].every((fingerprint) => next.has(fingerprint))) {
    return "same";
  }
  const overlap = [...next].filter((fingerprint) => baseline.has(fingerprint)).length;
  const smallerSize = Math.min(baseline.size, next.size);
  if (overlap >= 2 && smallerSize > 0 && overlap / smallerSize >= 0.5) return "same";
  return "uncertain";
}

/** Keep previously observed messages: shorter exports do not prove older messages were deleted. */
export function mergeMessages(
  savedMessages: readonly ChatMessage[],
  incomingMessages: readonly ChatMessage[],
): ChatMessage[] {
  const messages = new Map<string, ChatMessage>();
  for (const message of savedMessages) messages.set(message.id, message);
  for (const message of incomingMessages) messages.set(message.id, message);
  return [...messages.values()]
    .sort((a, b) => {
      if (a.timestamp && b.timestamp) return a.timestamp.localeCompare(b.timestamp) || a.sourceOrder - b.sourceOrder;
      if (a.timestamp) return -1;
      if (b.timestamp) return 1;
      return a.sourceOrder - b.sourceOrder;
    })
    .map((message, sourceOrder) => ({ ...message, sourceOrder }));
}

export function findingSignature(finding: Finding): string {
  return `${finding.category}:${finding.evidence.map(({ messageId }) => messageId).sort().join(",")}`;
}

function eventId(kind: TimelineKind, finding: Finding): string {
  return `event-${hash(`${kind}:${findingSignature(finding)}`)}`;
}

function eventForFinding(
  finding: Finding,
  kind: TimelineKind,
  messages: readonly ChatMessage[],
): TimelineEvent {
  const evidenceIds = finding.evidence.map(({ messageId }) => messageId);
  const evidence = evidenceIds
    .map((id) => messages.find((message) => message.id === id))
    .filter((message): message is ChatMessage => Boolean(message))
    .sort((a, b) => a.sourceOrder - b.sourceOrder);
  const latest = [...evidence].reverse().find((message) => message.timestamp);
  const rawTimestamp = latest?.timestamp ? new Date(latest.timestamp).getTime() : undefined;
  return {
    id: eventId(kind, finding),
    kind,
    whatChanged: finding.whatChanged,
    whyItMatters: finding.whyItMatters,
    whatToDoNext: finding.whatToDoNext,
    basis: finding.whatChangedBasis,
    evidenceMessageIds: evidenceIds,
    findingId: finding.id,
    sortTime: Number.isFinite(rawTimestamp) ? rawTimestamp : undefined,
    sourceOrder: evidence.at(-1)?.sourceOrder ?? 0,
  };
}

function topicWords(text: string): Set<string> {
  const ignored = new Set(["about", "after", "before", "from", "have", "into", "need", "that", "them", "then", "this", "will", "with", "your", "their", "they", "when", "were", "what"]);
  return new Set((text.toLocaleLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter((word) => !ignored.has(word)));
}

function sharedTopicWords(first: string, second: string): number {
  const a = topicWords(first);
  return [...topicWords(second)].filter((word) => a.has(word)).length;
}

function dateMentions(text: string): Set<string> {
  const monthDates = text.toLocaleLowerCase().match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,?\s+\d{4})?\b/g) ?? [];
  const numericDates = text.match(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g) ?? [];
  return new Set([...monthDates, ...numericDates].map((date) => date.replace(/\s+/g, " ").trim()));
}

export function buildCatchUpTimeline(
  previous: SavedConversationMemory | null,
  currentFindings: readonly Finding[],
  messages: readonly ChatMessage[],
): TimelineEvent[] {
  if (!previous) return [];

  const previousSignatures = new Set(previous.findings.map(({ finding }) => findingSignature(finding)));
  const currentBySignature = new Map(currentFindings.map((finding) => [findingSignature(finding), finding]));
  const events: TimelineEvent[] = [];
  const previousMessageIds = new Set(previous.messages.map(({ id }) => id));
  const changedPlanEvidence = new Set(currentFindings
    .filter((finding) => finding.category === "changed-plan" && finding.evidence.some(({ messageId }) => !previousMessageIds.has(messageId)))
    .map((finding) => `${finding.evidence.map(({ messageId }) => messageId).sort().join(",")}:${finding.whatChanged.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()}`));

  for (const finding of currentFindings) {
    if (!previousSignatures.has(findingSignature(finding))) {
      const sourceKey = `${finding.evidence.map(({ messageId }) => messageId).sort().join(",")}:${finding.whatChanged.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()}`;
      if (finding.category === "deadline" && changedPlanEvidence.has(sourceKey)) continue;
      let event = eventForFinding(finding, finding.category, messages);
      const hasNewEvidence = finding.evidence.some(({ messageId }) => !previousMessageIds.has(messageId));

      if (hasNewEvidence && (finding.category === "deadline" || finding.category === "changed-plan")) {
        const newDates = dateMentions(finding.whatChanged);
        const priorDeadlineCandidates = previous.findings
          .filter(({ finding: old }) => old.category === "deadline")
          .filter(({ finding: old }) => sharedTopicWords(old.whatChanged, finding.whatChanged) > 0 &&
            [...dateMentions(old.whatChanged)].some((date) => [...newDates].some((candidate) => candidate !== date)))
          .sort((a, b) => {
            const latestOrder = (record: SavedFinding) => Math.max(...record.finding.evidence.map(({ messageId }) => {
              const message = previous.messages.find(({ id }) => id === messageId);
              const timestamp = message?.timestamp ? Date.parse(message.timestamp) : 0;
              return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : message?.sourceOrder ?? 0;
            }));
            return latestOrder(b) - latestOrder(a);
          })[0];
        if (priorDeadline && /\b(?:moved|shifted|changed|pushed|pulled|now due|new deadline)\b/i.test(finding.whatChanged)) {
          event = {
            ...event,
            kind: "deadline",
            whatChanged: `Likely deadline change: ${finding.whatChanged}`,
            whyItMatters: "The new message uses change wording and a different date on a topic with a saved deadline; verify that they refer to the same commitment.",
            whatToDoNext: "Confirm which deadline is current and update the task owner or plan.",
            basis: "inferred",
            evidenceMessageIds: [...new Set([...priorDeadline.finding.evidence.map(({ messageId }) => messageId), ...finding.evidence.map(({ messageId }) => messageId)])],
          };
        }
      }

      if (hasNewEvidence && finding.category === "decision" &&
        /\b(?:instead|rather than|no longer|actually|replace the decision|changed our decision|switch(?:ed)? to)\b/i.test(finding.whatChanged)) {
        const earlier = previous.findings.find(({ finding: old }) => old.category === "decision" &&
          sharedTopicWords(old.whatChanged, finding.whatChanged) > 0);
        if (earlier) {
          event = {
            ...event,
            whatChanged: `A newer decision may supersede an earlier one: ${finding.whatChanged}`,
            whyItMatters: "Replacement wording and shared topic terms suggest the earlier decision may no longer apply; this interpretation needs confirmation.",
            whatToDoNext: "Confirm the current decision and share it with the people relying on the earlier one.",
            basis: "inferred",
            evidenceMessageIds: [...new Set([...earlier.finding.evidence.map(({ messageId }) => messageId), ...finding.evidence.map(({ messageId }) => messageId)])],
          };
        }
      }
      events.push(event);
    }
  }

  for (const record of previous.findings) {
    if (record.status === "completed" || record.finding.category !== "task" && record.finding.category !== "blocker") continue;
    const signature = findingSignature(record.finding);
    const existing = currentBySignature.get(signature);
    events.push(eventForFinding(existing ?? record.finding, "still-open", messages));
  }

  const previousIds = new Set(previous.timeline.map(({ id }) => id));
  const deduplicated = new Map<string, TimelineEvent>();
  const preference: Record<TimelineKind, number> = {
    "changed-plan": 0, blocker: 1, deadline: 2, task: 3, decision: 4, "still-open": 5,
  };
  for (const event of events) {
    const key = `${[...event.evidenceMessageIds].sort().join(",")}:${event.whatChanged.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase()}`;
    const existing = deduplicated.get(key);
    if (!existing || preference[event.kind] < preference[existing.kind]) deduplicated.set(key, event);
  }
  return [...deduplicated.values()]
    .filter((event) => event.kind === "still-open" || !previousIds.has(event.id))
    .sort((a, b) => {
      if (a.sortTime !== undefined && b.sortTime !== undefined) return a.sortTime - b.sortTime;
      if (a.sortTime !== undefined) return -1;
      if (b.sortTime !== undefined) return 1;
      return a.sourceOrder - b.sourceOrder;
    });
}

function validFinding(value: unknown, messageIds: Set<string>): value is Finding {
  if (!value || typeof value !== "object") return false;
  const finding = value as Partial<Finding>;
  return typeof finding.id === "string" && finding.id.length > 0 &&
    ["deadline", "decision", "changed-plan", "task", "blocker"].includes(finding.category ?? "") &&
    ["high", "medium", "low"].includes(finding.priority ?? "") &&
    ["whatChanged", "whyItMatters", "whatToDoNext", "reason"].every((key) =>
      typeof finding[key as keyof Finding] === "string" &&
      Boolean((finding[key as keyof Finding] as string).trim())) &&
    [finding.whatChangedBasis, finding.whyItMattersBasis, finding.whatToDoNextBasis]
      .every((basis) => basis === "explicit" || basis === "inferred") &&
    Array.isArray(finding.evidence) && finding.evidence.length > 0 &&
    finding.evidence.every((evidence) => Boolean(evidence && messageIds.has(evidence.messageId)));
}

function isSavedMemory(value: unknown): value is SavedConversationMemory {
  if (!value || typeof value !== "object") return false;
  const memory = value as Partial<SavedConversationMemory>;
  if (memory.schemaVersion !== MEMORY_SCHEMA_VERSION || typeof memory.conversationId !== "string" ||
    !memory.conversationId ||
    !Array.isArray(memory.messages) || !Array.isArray(memory.findings) ||
    !Array.isArray(memory.timeline) || !Array.isArray(memory.dismissedTimelineIds) ||
    typeof memory.lastProvider !== "string" ||
    typeof memory.lastNewMessageCount !== "number" || !Number.isInteger(memory.lastNewMessageCount) || memory.lastNewMessageCount < 0 ||
    typeof memory.comparisonCount !== "number" || !Number.isInteger(memory.comparisonCount) || memory.comparisonCount < 0 ||
    ![memory.firstImportedAt, memory.lastImportedAt, memory.lastAnalyzedAt].every((date) =>
      typeof date === "string" && Number.isFinite(Date.parse(date)))) return false;

  const ids = new Set<string>();
  if (memory.messages.length > 2_500 || memory.findings.length > 2_000 || memory.timeline.length > 1_000) return false;
  let totalTextCharacters = 0;
  for (const message of memory.messages) {
    if (!message || typeof message.id !== "string" || ids.has(message.id) ||
      !Number.isInteger(message.sourceOrder) || message.sourceOrder < 0 || typeof message.originalText !== "string" ||
      typeof message.sender !== "undefined" && typeof message.sender !== "string" ||
      typeof message.timestampText !== "undefined" && typeof message.timestampText !== "string" ||
      typeof message.timestamp !== "undefined" &&
        (typeof message.timestamp !== "string" || !Number.isFinite(Date.parse(message.timestamp)))) return false;
    ids.add(message.id);
    totalTextCharacters += message.originalText.length;
    if (totalTextCharacters > 500_000) return false;
  }
  if (memory.findings.some((record) => !record || typeof record.provider !== "string" ||
    !["new", "in-progress", "completed", "blocked"].includes(record.status) ||
    typeof record.reviewed !== "boolean" ||
    !validFinding(record.finding, ids))) return false;
  if (memory.timeline.some((event) => !event || typeof event.id !== "string" ||
    typeof event.findingId !== "string" || !Array.isArray(event.evidenceMessageIds) ||
    !event.evidenceMessageIds.every((id) => ids.has(id)))) return false;
  return true;
}

export function readMemory(raw: string | null): { memory: SavedConversationMemory | null; invalid: boolean } {
  if (raw === null) return { memory: null, invalid: false };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isSavedMemory(parsed)
      ? { memory: parsed, invalid: false }
      : { memory: null, invalid: true };
  } catch {
    return { memory: null, invalid: true };
  }
}

export function mergeSavedFindings(
  previous: SavedConversationMemory | null,
  currentFindings: readonly Finding[],
  provider: string,
): SavedFinding[] {
  const bySignature = new Map<string, SavedFinding>();
  for (const record of previous?.findings ?? []) bySignature.set(findingSignature(record.finding), record);
  for (const finding of currentFindings) {
    const signature = findingSignature(finding);
    const prior = bySignature.get(signature);
    bySignature.set(signature, {
      finding,
      provider,
      status: prior?.status ?? "new",
      reviewed: prior?.reviewed ?? false,
    });
  }
  return [...bySignature.values()];
}
