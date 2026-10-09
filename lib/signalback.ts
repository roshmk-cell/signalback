/**
 * Signalback's browser-safe conversation and finding pipeline.
 *
 * Supported text export: one message starts with
 * `YYYY-MM-DD, HH:mm - Sender: message text`; following lines belong to that
 * message until the next timestamped header. Timestamps are interpreted as
 * local wall-clock values and are preserved as source text.
 */

export const MAX_IMPORT_CHARACTERS = 250_000;

export type FindingCategory =
  | "deadline"
  | "decision"
  | "changed-plan"
  | "task"
  | "blocker";

export type FindingPriority = "high" | "medium" | "low";
export type ClaimBasis = "explicit" | "inferred";

export interface ChatMessage {
  /** Stable for a given message position within a parsed conversation. */
  id: string;
  /** Zero-based order in the source conversation. */
  sourceOrder: number;
  /** Exact message body, including supported continuation lines. */
  originalText: string;
  sender?: string;
  /** Parsed local wall-clock timestamp; absent when the source omits it. */
  timestamp?: string;
  /** Original timestamp spelling from the export. */
  timestampText?: string;
}

export interface ParsedConversation {
  id: string;
  source: "sample" | "import";
  format: "signalback-whatsapp-text-v1";
  messages: ChatMessage[];
}

export interface EvidenceReference {
  messageId: string;
}

export interface FindingCandidate {
  id: string;
  category: FindingCategory;
  whatChanged: string;
  whatChangedBasis: ClaimBasis;
  whyItMatters: string;
  whyItMattersBasis: ClaimBasis;
  whatToDoNext: string;
  whatToDoNextBasis: ClaimBasis;
  evidence: EvidenceReference[];
  /** Optional transparent rule signal, not a probability or confidence score. */
  reason: string;
}

export interface Finding extends FindingCandidate {
  priority: FindingPriority;
}

export interface AnalysisIssue {
  code:
    | "invalid-candidate"
    | "duplicate-id"
    | "missing-evidence"
    | "invalid-evidence"
    | "invalid-field";
  message: string;
  candidateId?: string;
}

export interface AnalysisResult {
  provider: "rules" | (string & {});
  findings: Finding[];
  issues: AnalysisIssue[];
}

export type InputErrorCode =
  | "empty-input"
  | "input-too-large"
  | "unsupported-format"
  | "malformed-input";

export interface InputError {
  code: InputErrorCode;
  message: string;
  line?: number;
}

export type ParseConversationResult =
  | { ok: true; conversation: ParsedConversation }
  | { ok: false; error: InputError };

/** Provider-neutral seam: future remote providers can return the same candidates. */
export interface AnalysisProvider {
  readonly id: string;
  analyze(messages: readonly ChatMessage[]): Promise<readonly FindingCandidate[]>;
}

const HEADER_PATTERN =
  /^(\d{4}-\d{2}-\d{2}), (\d{2}:\d{2}) - ([^:\r\n]{1,80}): (.*)$/;
const HEADER_LIKE_PATTERN = /^\d{4}-\d{2}-\d{2},\s/;

function makeMessageId(order: number): string {
  return `message-${String(order + 1).padStart(4, "0")}`;
}

function validDateAndTime(date: string, time: string): boolean {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const value = new Date(year, month - 1, day, hour, minute);
  return (
    value.getFullYear() === year &&
    value.getMonth() === month - 1 &&
    value.getDate() === day &&
    hour >= 0 && hour <= 23 &&
    minute >= 0 && minute <= 59
  );
}

/** Parse only Signalback's documented WhatsApp-style export format. */
export function parseChatText(
  input: string,
  conversationId = "imported-conversation",
): ParseConversationResult {
  if (!input.trim()) {
    return { ok: false, error: { code: "empty-input", message: "The file is empty." } };
  }
  if (input.length > MAX_IMPORT_CHARACTERS) {
    return {
      ok: false,
      error: {
        code: "input-too-large",
        message: `The file exceeds the ${MAX_IMPORT_CHARACTERS.toLocaleString()} character limit.`,
      },
    };
  }

  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const messages: ChatMessage[] = [];
  let current: ChatMessage | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const header = HEADER_PATTERN.exec(line);
    if (header) {
      const [, date, time, sender, body] = header;
      if (!validDateAndTime(date, time)) {
        return {
          ok: false,
          error: {
            code: "malformed-input",
            message: "A message contains an invalid date or time.",
            line: index + 1,
          },
        };
      }
      current = {
        id: makeMessageId(messages.length),
        sourceOrder: messages.length,
        sender: sender.trim(),
        timestamp: `${date}T${time}:00`,
        timestampText: `${date}, ${time}`,
        originalText: body,
      };
      messages.push(current);
      continue;
    }

    if (HEADER_LIKE_PATTERN.test(line)) {
      return {
        ok: false,
        error: {
          code: "malformed-input",
          message: "A timestamped line does not match the supported message format.",
          line: index + 1,
        },
      };
    }

    if (!current) {
      if (line.trim()) {
        return {
          ok: false,
          error: {
            code: "unsupported-format",
            message: "Expected a message beginning `YYYY-MM-DD, HH:mm - Sender: message`.",
            line: index + 1,
          },
        };
      }
      continue;
    }

    // Preserve continuation content and blank lines inside a message.
    current.originalText += `\n${line}`;
  }

  if (messages.length === 0) {
    return {
      ok: false,
      error: {
        code: "unsupported-format",
        message: "No supported timestamped messages were found.",
      },
    };
  }

  return {
    ok: true,
    conversation: {
      id: conversationId,
      source: "import",
      format: "signalback-whatsapp-text-v1",
      messages,
    },
  };
}

const SAMPLE_BASELINE_TEXT = `2026-10-08, 09:10 - Maya: The vendor review is due Friday, October 16.
2026-10-08, 09:17 - Priya: I will update the preview copy and send it for review by Monday, October 12.
2026-10-08, 09:20 - Leo: I am blocked on the final pricing table; Finance has not sent the approved numbers yet.
2026-10-08, 09:26 - Maya: Agreed: use the current approved prices for this preview, then replace them after Finance confirms.
2026-10-08, 09:29 - Priya: I will mark the preview as provisional so nobody treats those prices as final.`;

const SAMPLE_UPDATE_TEXT = `${SAMPLE_BASELINE_TEXT}
2026-10-09, 10:05 - Leo: The vendor moved the review from Friday, October 16, to Wednesday, October 14. The preview now needs to be ready by Tuesday, October 13.`;

/** Sample input is parsed by the same public parser as user-imported text. */
export function loadSampleConversation(): ParseConversationResult {
  const result = parseChatText(SAMPLE_BASELINE_TEXT, "signalback-sample");
  if (!result.ok) {
    // A compile-time-owned constant should always parse; preserve result shape if edited incorrectly.
    return {
      ok: false,
      error: {
        code: "malformed-input",
        message: `Signalback's built-in sample is invalid: ${result.error.message}`,
      },
    };
  }
  return {
    ok: true,
    conversation: { ...result.conversation, source: "sample" },
  };
}

/** Full updated export used by the opt-in sample comparison demonstration. */
export function loadSampleUpdateConversation(): ParseConversationResult {
  const result = parseChatText(SAMPLE_UPDATE_TEXT, "signalback-sample");
  if (!result.ok) {
    return {
      ok: false,
      error: {
        code: "malformed-input",
        message: `Signalback's built-in sample update is invalid: ${result.error.message}`,
      },
    };
  }
  return { ok: true, conversation: { ...result.conversation, source: "sample" } };
}

function stableFindingId(category: FindingCategory, evidenceIds: readonly string[]): string {
  return `${category}-${evidenceIds.join("-")}`;
}

function candidate(
  category: FindingCategory,
  message: ChatMessage,
  whatChanged: string,
  whyItMatters: string,
  whatToDoNext: string,
  reason: string,
  extraEvidence: readonly ChatMessage[] = [],
): FindingCandidate {
  const evidence = [message, ...extraEvidence]
    .sort((a, b) => a.sourceOrder - b.sourceOrder)
    .map(({ id }) => ({ messageId: id }));
  return {
    id: stableFindingId(category, evidence.map(({ messageId }) => messageId)),
    category,
    whatChanged,
    whatChangedBasis: "explicit",
    whyItMatters,
    whyItMattersBasis: "inferred",
    whatToDoNext,
    whatToDoNextBasis: "inferred",
    evidence,
    reason,
  };
}

const DEADLINE_PATTERN =
  /\b(?:by|before|deadline(?: is)?|due(?: on)?|no later than)\s+(?:(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:,?\s+))?(?:\w+\s+\d{1,2}(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{1,2}:\d{2}\s*(?:am|pm)?)\b/i;
const PLAN_CHANGE_PATTERN =
  /\b(?:moved|shifted|changed|pushed|pulled)\b.{0,100}?\bto\s+(.+?)(?:[.!?]|$)/i;
const BLOCKER_PATTERN =
  /\b(?:blocked\s+(?:on|by|waiting for)?|can't proceed|cannot proceed|unable to proceed|waiting on|waiting for|depends on)\s+(.+?)(?:[.!?]|$)/i;
const DECISION_PATTERN =
  /\b(?:decided|decision is|agreed|we agree|locked in|we will use|let's use)\b(.+?)(?:[.!?]|$)/i;
const TASK_PATTERN =
  /\b(?:i(?:'ll| will)|we(?:'ll| will)|please)\s+((?:update|send|share|review|prepare|finish|complete|confirm|check|publish|create|replace|mark|deliver|schedule|notify|follow up)\b.+?)(?:[.!?]|$)/i;
const DATE_TOKEN_PATTERN =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b|\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/i;

const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
] as const;

function deadlineCue(text: string): string | null {
  return DEADLINE_PATTERN.exec(text)?.[0]?.trim() ?? null;
}

function dateFromCue(cue: string, sourceYear: number | undefined): Date | null {
  const monthDate = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i.exec(cue);
  if (!monthDate) return null;
  const month = MONTHS.indexOf(monthDate[1].toLocaleLowerCase() as (typeof MONTHS)[number]);
  const day = Number(monthDate[2]);
  const year = Number(monthDate[3]) || sourceYear;
  if (month < 0 || !year) return null;
  const date = new Date(year, month, day);
  return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day
    ? date
    : null;
}

/** Return a date only when a finding's source explicitly states a calendar date. */
export function getFindingDueDate(
  finding: FindingCandidate,
  messages: readonly ChatMessage[],
): Date | null {
  if (!["deadline", "changed-plan", "task"].includes(finding.category) || finding.whatChangedBasis !== "explicit") return null;
  const byId = new Map(messages.map((message) => [message.id, message]));
  for (const { messageId } of finding.evidence) {
    const message = byId.get(messageId);
    if (!message) continue;
    const source = message.originalText;
    const cue = deadlineCue(source);
    if (cue) {
      const sourceYear = message.timestamp ? Number(message.timestamp.slice(0, 4)) : undefined;
      const parsed = dateFromCue(cue, sourceYear);
      if (parsed) return parsed;
    }
    if (finding.category === "changed-plan") {
      const changeTarget = PLAN_CHANGE_PATTERN.exec(source)?.[1];
      if (changeTarget) {
        const parsed = dateFromCue(changeTarget, message.timestamp ? Number(message.timestamp.slice(0, 4)) : undefined);
        if (parsed) return parsed;
      }
    }
  }
  return null;
}

function daysFromToday(date: Date, today: Date): number {
  const due = Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
  const current = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((due - current) / 86_400_000);
}

/** Conservative local rules; these rules are not an AI model. */
export class RuleBasedAnalysisProvider implements AnalysisProvider {
  readonly id = "rules" as const;

  async analyze(messages: readonly ChatMessage[]): Promise<readonly FindingCandidate[]> {
    const candidates: FindingCandidate[] = [];

    for (const message of messages) {
      const text = message.originalText.trim();
      if (!text) continue;

      const changed = PLAN_CHANGE_PATTERN.exec(text);
      const task = TASK_PATTERN.exec(text);
      if (changed && /\b(?:from|moved|shifted|changed|pushed|pulled)\b/i.test(text)) {
        candidates.push(candidate(
          "changed-plan", message,
          text,
          "A stated plan changed, which may affect preparation and handoffs.",
          deadlineCue(text)
            ? `Update the handoff to meet the deadline ${deadlineCue(text)}.`
            : `Confirm the new plan with the people handling the handoff to ${changed[1].trim()}.`,
          "Explicit plan-change wording matched.",
        ));
      }

      const deadline = DEADLINE_PATTERN.exec(text);
      // A date attached to a task or changed plan enriches that one finding;
      // a second deadline card for the same source message is redundant.
      if (deadline && !task && !changed) {
        candidates.push(candidate(
          "deadline", message,
          text,
          "A time-bound commitment is stated and may affect work sequencing.",
          `Make sure the team is ready ${deadline[0].trim()}.`,
          "Explicit deadline wording and date/time matched.",
        ));
      }

      const blocker = BLOCKER_PATTERN.exec(text);
      if (blocker) {
        candidates.push(candidate(
          "blocker", message,
          text,
          "The message explicitly describes a dependency or inability to proceed.",
          `Follow up on the dependency: ${blocker[1].trim()}`,
          "Explicit blocker/dependency wording matched.",
        ));
      }

      const decision = DECISION_PATTERN.exec(text);
      if (decision) {
        const decisionText = decision[1].replace(/^[:\s]+/, "").trim();
        const keepChoice = /\buse\s+(.+?),?\s+then\s+replace\b/i.exec(decisionText)?.[1]?.trim();
        const replacement = /\bthen\s+replace\s+(.+?)\s+after\b/i.exec(decisionText)?.[1]?.trim();
        const confirmation = /\bafter\s+(.+?)(?:[.!?]|$)/i.exec(decisionText)?.[1]?.trim();
        candidates.push(candidate(
          "decision", message,
          decisionText,
          "An explicit agreement or decision can change what the team should treat as current.",
          keepChoice && replacement && confirmation
            ? `Keep ${keepChoice} in place until ${confirmation}; then replace ${replacement}.`
            : "Share this decision with the people relying on the previous plan.",
          "Explicit decision/agreement wording matched.",
        ));
      }

      if (task) {
        const taskDescription = task[1].trim();
        const dateMatches = DATE_TOKEN_PATTERN.test(taskDescription);
        const cue = deadlineCue(text);
        const isFirstPersonCommitment = /^\s*i(?:'ll|\s+will)\b/i.test(text);
        const nextAction = /^\s*please\b/i.test(text)
          ? `Confirm who owns this request${cue ? ` and whether it is on track ${cue}` : " and when it is due"}.`
          : isFirstPersonCommitment && message.sender
            ? `Check with ${message.sender} that this task is complete${cue ? ` ${cue}` : ""}.`
            : `Confirm that this task is complete${cue ? ` ${cue}` : ""}.`;
        candidates.push(candidate(
          "task", message,
          taskDescription,
          dateMatches
            ? "A person explicitly commits to an action with a date-like detail."
            : "A person explicitly commits to an action.",
          nextAction,
          "Explicit first-person or polite task wording matched.",
        ));
      }
    }

    return candidates;
  }
}

/** Explainable rank policy, kept independent from parsing and providers. */
export function prioritizeFindings(
  findings: readonly FindingCandidate[],
  messages: readonly ChatMessage[] = [],
  today = new Date(),
): Finding[] {
  const rank: Record<FindingPriority, number> = { high: 0, medium: 1, low: 2 };
  return findings
    .map((finding, index) => {
      const dueDate = getFindingDueDate(finding, messages);
      const dueInDays = dueDate ? daysFromToday(dueDate, today) : undefined;
      const priority: FindingPriority = finding.category === "blocker" || dueInDays !== undefined && dueInDays <= 2
        ? "high"
        : dueInDays !== undefined
          ? dueInDays <= 7 ? "medium" : "low"
          : finding.category === "changed-plan" || finding.category === "deadline" || finding.category === "decision"
            ? "medium"
            : "low";
      return { finding, priority, dueInDays, order: index };
    })
    .sort((a, b) => rank[a.priority] - rank[b.priority] ||
      (a.dueInDays ?? Number.POSITIVE_INFINITY) - (b.dueInDays ?? Number.POSITIVE_INFINITY) || a.order - b.order)
    .map(({ finding, priority }) => ({ ...finding, priority }));
}

function validateAndPrioritize(
  candidates: readonly FindingCandidate[],
  messages: readonly ChatMessage[],
): { findings: Finding[]; issues: AnalysisIssue[] } {
  const messageIds = new Set(messages.map(({ id }) => id));
  const findingIds = new Set<string>();
  const valid: FindingCandidate[] = [];
  const issues: AnalysisIssue[] = [];

  for (const raw of candidates as readonly unknown[]) {
    if (!raw || typeof raw !== "object") {
      issues.push({ code: "invalid-candidate", message: "An analysis candidate was not an object." });
      continue;
    }
    const value = raw as Partial<FindingCandidate>;
    const candidateId = typeof value.id === "string" ? value.id : undefined;
    const requiredStrings = [value.id, value.whatChanged, value.whyItMatters, value.whatToDoNext, value.reason];
    if (
      requiredStrings.some((field) => typeof field !== "string" || field.trim().length === 0) ||
      !["deadline", "decision", "changed-plan", "task", "blocker"].includes(value.category ?? "") ||
      !["explicit", "inferred"].includes(value.whatChangedBasis ?? "") ||
      !["explicit", "inferred"].includes(value.whyItMattersBasis ?? "") ||
      !["explicit", "inferred"].includes(value.whatToDoNextBasis ?? "") ||
      !Array.isArray(value.evidence)
    ) {
      issues.push({
        code: "invalid-field",
        message: "A candidate is missing required fields or contains an unsupported category/basis.",
        candidateId,
      });
      continue;
    }
    if (findingIds.has(value.id!)) {
      issues.push({ code: "duplicate-id", message: "Duplicate finding ID was rejected.", candidateId });
      continue;
    }
    findingIds.add(value.id!);

    const evidence = value.evidence as EvidenceReference[];
    if (evidence.length === 0) {
      issues.push({ code: "missing-evidence", message: "A finding without evidence was rejected.", candidateId });
      continue;
    }
    if (evidence.some((item) => !item || typeof item.messageId !== "string" || !messageIds.has(item.messageId))) {
      issues.push({ code: "invalid-evidence", message: "A finding referenced a missing source message and was rejected.", candidateId });
      continue;
    }
    valid.push(value as FindingCandidate);
  }

  return { findings: prioritizeFindings(valid, messages), issues };
}

/** Run provider analysis, validate against this conversation, then rank results. */
export async function analyzeConversation(
  messages: readonly ChatMessage[],
  provider: AnalysisProvider = new RuleBasedAnalysisProvider(),
): Promise<AnalysisResult> {
  const candidates = await provider.analyze(messages);
  const { findings, issues } = validateAndPrioritize(candidates, messages);
  return { provider: provider.id, findings, issues };
}

/** Convenience entry point shared by sample and file-import workflows. */
export async function processConversation(
  conversation: ParsedConversation,
  provider?: AnalysisProvider,
): Promise<AnalysisResult> {
  return analyzeConversation(conversation.messages, provider);
}
