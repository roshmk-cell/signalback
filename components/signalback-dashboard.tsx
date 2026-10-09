"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import {
  analyzeConversation,
  loadSampleConversation,
  parseChatText,
  type AnalysisIssue,
  type AnalysisResult,
  type ChatMessage,
  type Finding,
  type FindingCategory,
  type FindingPriority,
  type ParsedConversation,
} from "@/lib/signalback";
import {
  MEMORY_STORAGE_KEY,
  buildCatchUpTimeline,
  findingSignature,
  matchImport,
  mergeMessages,
  mergeSavedFindings,
  readMemory,
  stabilizeConversation,
  type FindingStatus,
  type SavedConversationMemory,
} from "@/lib/signalback-memory";

type StatusFilter = "unresolved" | "resolved" | "all";
type CategoryFilter = FindingCategory | "all";
type PriorityFilter = FindingPriority | "all";
type AnalysisMode = "rules" | "gemini";

const CATEGORIES: { value: FindingCategory; label: string }[] = [
  { value: "changed-plan", label: "Changed plan" },
  { value: "blocker", label: "Blocker" },
  { value: "deadline", label: "Deadline" },
  { value: "decision", label: "Decision" },
  { value: "task", label: "Action item" },
];

const CATEGORY_LABEL: Record<FindingCategory, string> = {
  "changed-plan": "Changed plan",
  blocker: "Blocker",
  deadline: "Deadline",
  decision: "Decision",
  task: "Action item",
};

const PRIORITY_LABEL: Record<FindingPriority, string> = {
  high: "High priority",
  medium: "Medium priority",
  low: "Lower priority",
};

function formatTimestamp(message: ChatMessage): string {
  if (!message.timestampText) return `Message ${message.sourceOrder + 1}`;
  const [date, time] = message.timestampText.split(", ");
  return `${date} · ${time}`;
}

function DisplayBasis({ basis }: { basis: "explicit" | "inferred" }) {
  return (
    <span className={`basis-tag ${basis}`}>
      {basis === "explicit" ? "From message" : "Interpretation"}
    </span>
  );
}

function SelectFilter({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="filter-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function isUpcomingConfirmedDeadline(finding: Finding, messages: ReadonlyMap<string, ChatMessage>): boolean {
  if (finding.category !== "deadline" || finding.whatChangedBasis !== "explicit") return false;
  const text = finding.whatChanged;
  const match = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/i.exec(text);
  if (!match) return false;
  const month = new Date(`${match[1]} 1, 2000`).getMonth();
  const sourceYear = finding.evidence
    .map(({ messageId }) => messages.get(messageId)?.timestamp)
    .find((timestamp): timestamp is string => Boolean(timestamp))
    ?.slice(0, 4);
  const year = Number(match[3]) || (sourceYear ? Number(sourceYear) : new Date().getFullYear());
  const date = new Date(year, month, Number(match[2]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Number.isFinite(date.getTime()) && date >= today;
}

function decisionNeedsConfirmation(finding: Finding, messages: ReadonlyMap<string, ChatMessage>): boolean {
  if (finding.category !== "decision") return false;
  const source = finding.evidence.map(({ messageId }) => messages.get(messageId)?.originalText ?? "").join(" ");
  return /\b(?:awaiting confirmation|pending approval|need(?:s)? to confirm|please confirm|still need(?:s)? a decision)\b/i.test(source);
}

function FindingsCard({
  finding,
  messages,
  status,
  reviewed,
  savedProvider,
  expanded,
  onStatusChange,
  onToggleReviewed,
  onToggleEvidence,
}: {
  finding: Finding;
  messages: ReadonlyMap<string, ChatMessage>;
  status: FindingStatus;
  reviewed: boolean;
  savedProvider?: string;
  expanded: boolean;
  onStatusChange: (status: FindingStatus) => void;
  onToggleReviewed: () => void;
  onToggleEvidence: () => void;
}) {
  const evidenceMessages = finding.evidence
    .map(({ messageId }) => messages.get(messageId))
    .filter((message): message is ChatMessage => Boolean(message));

  return (
    <article className={`finding-card priority-${finding.priority}${status === "completed" ? " is-resolved" : ""}`}>
      <div className="finding-topline">
        <div className="finding-tags">
          <span className={`priority-pill ${finding.priority}`}>
            <span className="priority-dot" aria-hidden="true" />
            {PRIORITY_LABEL[finding.priority]}
          </span>
          <span className="category-pill">{CATEGORY_LABEL[finding.category]}</span>
          {savedProvider && <span className="memory-origin">Saved · {savedProvider === "gemini" ? "Gemini" : "local rules"}</span>}
        </div>
        <span className={`resolution-state${status === "completed" ? " done" : status === "blocked" ? " blocked" : ""}`}>
          <span aria-hidden="true">{status === "completed" ? "✓" : status === "blocked" ? "!" : "○"}</span>
          {status === "completed" ? "Completed" : status === "blocked" ? "Blocked" : status === "in-progress" ? "In progress" : reviewed ? "Reviewed" : "New"}
        </span>
      </div>

      <section className="finding-section">
        <h3>What changed</h3>
        <div className="claim-line">
          <p>{finding.whatChanged}</p>
          <DisplayBasis basis={finding.whatChangedBasis} />
        </div>
      </section>

      <div className="finding-detail-grid">
        <section className="finding-section">
          <h3>Why it matters</h3>
          <div className="claim-line">
            <p>{finding.whyItMatters}</p>
            <DisplayBasis basis={finding.whyItMattersBasis} />
          </div>
        </section>
        <section className="finding-section next-step">
          <h3>What to do next</h3>
          <div className="claim-line">
            <p>{finding.whatToDoNext}</p>
            <DisplayBasis basis={finding.whatToDoNextBasis} />
          </div>
        </section>
      </div>

      <div className="finding-actions">
        <button
          className="text-button evidence-button"
          type="button"
          aria-expanded={expanded}
          onClick={onToggleEvidence}
        >
          <span className="evidence-icon" aria-hidden="true">↳</span>
          {expanded ? "Hide source messages" : `View source messages (${evidenceMessages.length})`}
          <span className={`chevron${expanded ? " up" : ""}`} aria-hidden="true">⌄</span>
        </button>
        <div className="memory-actions">
          <label className="finding-status-control">
            <span className="visually-hidden">Finding status</span>
            <select value={status} onChange={(event) => onStatusChange(event.target.value as FindingStatus)} aria-label={`Status for ${finding.whatChanged}`}>
              <option value="new">New</option>
              <option value="in-progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="completed">Completed</option>
            </select>
          </label>
          <button className={`review-button${reviewed ? " is-reviewed" : ""}`} type="button" aria-pressed={reviewed} onClick={onToggleReviewed}>
            {reviewed ? "Reviewed ✓" : "Mark reviewed"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="evidence-list" aria-label="Original supporting messages">
          {evidenceMessages.length ? evidenceMessages.map((message) => (
            <figure className="evidence-message" key={message.id}>
              <figcaption>
                <span className="evidence-sender">{message.sender || "Unknown sender"}</span>
                <time>{formatTimestamp(message)}</time>
              </figcaption>
              <blockquote>{message.originalText}</blockquote>
            </figure>
          )) : (
            <p className="inline-warning">Source messages are unavailable for this finding.</p>
          )}
        </div>
      )}
    </article>
  );
}

export default function SignalbackDashboard() {
  const [conversation, setConversation] = useState<ParsedConversation | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResult | null>(null);
  const [memory, setMemory] = useState<SavedConversationMemory | null>(null);
  const [memoryReady, setMemoryReady] = useState(false);
  const [memoryNotice, setMemoryNotice] = useState<string | null>(null);
  const [pendingImport, setPendingImport] = useState<ParsedConversation | null>(null);
  const [findingStatuses, setFindingStatuses] = useState<Record<string, FindingStatus>>({});
  const [reviewedIds, setReviewedIds] = useState<Set<string>>(() => new Set());
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(() => new Set());
  const [expandedTimelineIds, setExpandedTimelineIds] = useState<Set<string>>(() => new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>("all");
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("all");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("unresolved");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const [announcement, setAnnouncement] = useState("");
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>("rules");
  const [remoteConsent, setRemoteConsent] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const requestId = useRef(0);
  const comparisonBaselineRef = useRef<SavedConversationMemory | null>(null);
  const activeImportTimeRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      const loaded = readMemory(window.localStorage.getItem(MEMORY_STORAGE_KEY));
      if (loaded.invalid) {
        window.localStorage.removeItem(MEMORY_STORAGE_KEY);
        setMemoryNotice("Saved memory could not be read and was cleared. Import the conversation again to start a fresh baseline.");
      }
      if (loaded.memory) {
        const saved = loaded.memory;
        comparisonBaselineRef.current = saved;
        activeImportTimeRef.current = saved.lastImportedAt;
        setMemory(saved);
        setConversation({
          id: saved.conversationId,
          source: "import",
          format: "signalback-whatsapp-text-v1",
          messages: saved.messages,
        });
        setAnalysis({ provider: saved.lastProvider, findings: saved.findings.map(({ finding }) => finding), issues: [] });
        setFindingStatuses(Object.fromEntries(saved.findings.map(({ finding, status }) => [finding.id, status])));
        setReviewedIds(new Set(saved.findings.filter(({ reviewed }) => reviewed).map(({ finding }) => finding.id)));
        setDismissedIds(new Set(saved.dismissedTimelineIds));
      }
    } catch {
      setMemoryNotice("Browser storage is unavailable. This session will work, but changes cannot be remembered after it closes.");
    } finally {
      setMemoryReady(true);
    }
  }, []);

  function saveMemory(next: SavedConversationMemory) {
    try {
      const serialized = JSON.stringify(next);
      if (serialized.length > 1_500_000) {
        setMemoryNotice("This conversation’s saved memory exceeded the browser storage limit. Nothing was overwritten; remove older messages or delete the saved memory to continue.");
        return;
      }
      window.localStorage.setItem(MEMORY_STORAGE_KEY, serialized);
      setMemory(next);
      setMemoryNotice(null);
    } catch {
      setMemoryNotice("The browser could not save this conversation. Check available site storage; the current session remains usable.");
    }
  }

  function commitImportedAnalysis(
    next: ParsedConversation,
    result: AnalysisResult,
    baseline: SavedConversationMemory | null,
  ) {
    const now = new Date().toISOString();
    const importedAt = activeImportTimeRef.current ?? now;
    const isNewImport = !baseline || importedAt !== baseline.lastImportedAt;
    const events = isNewImport
      ? buildCatchUpTimeline(baseline, result.findings, next.messages)
      : baseline.timeline;
    const records = mergeSavedFindings(baseline, result.findings, result.provider);
    const updated: SavedConversationMemory = {
      schemaVersion: 1,
      conversationId: next.id,
      messages: next.messages,
      findings: records,
      timeline: events,
      dismissedTimelineIds: baseline?.dismissedTimelineIds.slice(-500) ?? [],
      firstImportedAt: baseline?.firstImportedAt ?? now,
      lastImportedAt: importedAt,
      lastAnalyzedAt: now,
      lastProvider: result.provider,
      lastNewMessageCount: !isNewImport && baseline
        ? baseline.lastNewMessageCount
        : baseline
        ? next.messages.filter((message) => !baseline.messages.some((savedMessage) => savedMessage.id === message.id)).length
        : 0,
      comparisonCount: baseline ? baseline.comparisonCount + (isNewImport ? 1 : 0) : 0,
    };
    comparisonBaselineRef.current = updated;
    saveMemory(updated);
    setFindingStatuses(Object.fromEntries(records.map(({ finding, status }) => [finding.id, status])));
    setReviewedIds(new Set(records.filter(({ reviewed }) => reviewed).map(({ finding }) => finding.id)));
    setDismissedIds(new Set(updated.dismissedTimelineIds));
  }

  async function runLocal(next: ParsedConversation, baseline: SavedConversationMemory | null = comparisonBaselineRef.current) {
    const thisRequest = ++requestId.current;
    setError(null);
    setBusy(true);
    setAnnouncement(`Analyzing ${next.messages.length} messages with local rule-based analysis.`);
    try {
      const result = await analyzeConversation(next.messages);
      if (thisRequest !== requestId.current) return;
      setAnalysis(result);
      if (next.source === "import") commitImportedAnalysis(next, result, baseline);
      setAnnouncement(`Analysis complete. ${result.findings.length} verified findings.`);
    } catch (caught) {
      if (thisRequest !== requestId.current) return;
      const message = caught instanceof Error ? caught.message : "Analysis could not be completed.";
      setError(message);
      setAnnouncement("Analysis failed.");
    } finally {
      if (thisRequest === requestId.current) setBusy(false);
    }
  }

  async function runGemini(next: ParsedConversation, baseline: SavedConversationMemory | null = comparisonBaselineRef.current) {
    if (!remoteConsent) return;
    const thisRequest = ++requestId.current;
    setBusy(true);
    setError(null);
    setAnnouncement(`Sending ${next.messages.length} messages for Gemini analysis. Conversation content will be sent to Google.`);
    try {
      const response = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: next.messages }),
      });
      const payload: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const errorPayload = payload && typeof payload === "object" && "error" in payload
          ? payload.error
          : null;
        const message = errorPayload && typeof errorPayload === "object" &&
          "message" in errorPayload && typeof errorPayload.message === "string"
          ? errorPayload.message
          : `Gemini request failed (HTTP ${response.status}).`;
        throw new Error(message);
      }
      if (!payload || typeof payload !== "object" ||
        !("provider" in payload) || payload.provider !== "gemini" ||
        !("findings" in payload) || !Array.isArray(payload.findings) ||
        !("issues" in payload) || !Array.isArray(payload.issues)) {
        throw new Error("Gemini returned an invalid analysis response. Retry or switch to local analysis.");
      }
      const result = payload as AnalysisResult;
      const activeIds = new Set(next.messages.map(({ id }) => id));
      if (result.findings.some((finding) =>
        !finding || !Array.isArray(finding.evidence) || finding.evidence.length === 0 ||
        finding.evidence.some(({ messageId }) => !activeIds.has(messageId)),
      )) {
        throw new Error("Gemini returned a finding with unverifiable evidence. Retry or switch to local analysis.");
      }
      if (thisRequest !== requestId.current) return;
      setAnalysis(result);
      setExpandedIds(new Set());
      if (next.source === "import") commitImportedAnalysis(next, result, baseline);
      setAnnouncement(`Gemini analysis complete. ${result.findings.length} findings with verified evidence references.`);
    } catch (caught) {
      if (thisRequest !== requestId.current) return;
      setError(caught instanceof Error ? caught.message : "Gemini analysis failed. Retry or switch to local analysis.");
      setAnnouncement("Gemini analysis failed. Existing results remain labelled by their original analysis mode.");
    } finally {
      if (thisRequest === requestId.current) setBusy(false);
    }
  }

  async function activateConversation(next: ParsedConversation) {
    ++requestId.current;
    comparisonBaselineRef.current = null;
    activeImportTimeRef.current = null;
    setPendingImport(null);
    setConversation(next);
    setAnalysis(null);
    setError(null);
    setFindingStatuses({});
    setReviewedIds(new Set());
    setExpandedIds(new Set());
    setExpandedTimelineIds(new Set());
    setCategoryFilter("all");
    setPriorityFilter("all");
    setStatusFilter("unresolved");
    setRemoteConsent(false);
    if (analysisMode === "rules") {
      await runLocal(next);
    } else {
      setBusy(false);
      setAnnouncement("Conversation loaded. Review the remote privacy disclosure and explicitly run Gemini analysis when ready.");
    }
  }

  async function activateImportedConversation(
    incoming: ParsedConversation,
    baseline: SavedConversationMemory | null,
  ) {
    const next: ParsedConversation = baseline
      ? {
          ...incoming,
          id: baseline.conversationId,
          messages: mergeMessages(baseline.messages, incoming.messages),
        }
      : { ...incoming, id: `import-${Date.now()}` };
    ++requestId.current;
    comparisonBaselineRef.current = baseline;
    activeImportTimeRef.current = new Date().toISOString();
    setConversation(next);
    setAnalysis(baseline
      ? { provider: baseline.lastProvider, findings: baseline.findings.map(({ finding }) => finding), issues: [] }
      : null);
    setError(null);
    setFindingStatuses(baseline ? Object.fromEntries(baseline.findings.map(({ finding, status }) => [finding.id, status])) : {});
    setReviewedIds(new Set(baseline?.findings.filter(({ reviewed }) => reviewed).map(({ finding }) => finding.id) ?? []));
    setDismissedIds(new Set(baseline?.dismissedTimelineIds ?? []));
    setExpandedIds(new Set());
    setExpandedTimelineIds(new Set());
    setCategoryFilter("all");
    setPriorityFilter("all");
    setStatusFilter("unresolved");
    setRemoteConsent(false);
    if (analysisMode === "rules") {
      await runLocal(next, baseline);
    } else {
      setBusy(false);
      setAnnouncement("Conversation loaded. Review the remote privacy disclosure and explicitly run Gemini analysis when ready.");
    }
  }

  function selectAnalysisMode(mode: AnalysisMode) {
    setAnalysisMode(mode);
    setRemoteConsent(false);
    setError(null);
    if (mode === "rules" && conversation) {
      void runLocal(conversation);
    } else if (mode === "gemini") {
      setAnnouncement("Gemini selected. No conversation is sent until you consent and choose Analyze with Gemini.");
    }
  }

  async function handleImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError(null);
    setBusy(true);
    setAnnouncement(`Reading ${file.name}.`);
    try {
      const content = await file.text();
      const parsed = parseChatText(content, "incoming-import");
      if (!parsed.ok) {
        setError(`${parsed.error.message}${parsed.error.line ? ` (line ${parsed.error.line})` : ""}`);
        setAnnouncement("Import could not be read.");
        setBusy(false);
        return;
      }
      const incoming = stabilizeConversation(parsed.conversation);
      if (memory && matchImport(memory, incoming) === "same") {
        await activateImportedConversation(incoming, memory);
      } else if (memory) {
        setPendingImport(incoming);
        setBusy(false);
        setAnnouncement("Choose whether to compare this import with saved memory or start a new conversation.");
      } else {
        await activateImportedConversation(incoming, null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The file could not be read.");
      setAnnouncement("Import failed.");
      setBusy(false);
    }
  }

  async function handleSample() {
    const sample = loadSampleConversation();
    if (!sample.ok) {
      setError(sample.error.message);
      return;
    }
    await activateConversation(sample.conversation);
  }

  function resolvePendingImport(choice: "compare" | "new") {
    if (!pendingImport) return;
    const incoming = pendingImport;
    const baseline = choice === "compare" ? memory : null;
    setPendingImport(null);
    void activateImportedConversation(incoming, baseline);
  }

  function deleteSavedMemory() {
    try {
      window.localStorage.removeItem(MEMORY_STORAGE_KEY);
    } catch {
      setMemoryNotice("The browser could not remove its saved memory. Check site storage permissions and try again.");
      return;
    }
    ++requestId.current;
    comparisonBaselineRef.current = null;
    activeImportTimeRef.current = null;
    setMemory(null);
    setMemoryNotice("Saved conversation memory was deleted from this browser.");
    setPendingImport(null);
    setConfirmDelete(false);
    setFindingStatuses({});
    setReviewedIds(new Set());
    setDismissedIds(new Set());
    if (conversation?.source === "import") {
      setConversation(null);
      setAnalysis(null);
      setError(null);
    }
  }

  function updateFindingStatus(finding: Finding, status: FindingStatus) {
    setFindingStatuses((current) => ({ ...current, [finding.id]: status }));
    if (!activeMemory) return;
    const signature = findingSignature(finding);
    const existing = activeMemory.findings.find((record) => findingSignature(record.finding) === signature);
    const records = existing
      ? activeMemory.findings.map((record) => findingSignature(record.finding) === signature ? { ...record, status } : record)
      : [...activeMemory.findings, { finding, provider: analysis?.provider ?? "rules", status, reviewed: reviewedIds.has(finding.id) }];
    saveMemory({ ...activeMemory, findings: records });
  }

  function toggleReviewed(finding: Finding) {
    const nextReviewed = !reviewedIds.has(finding.id);
    setReviewedIds((current) => {
      const next = new Set(current);
      if (nextReviewed) next.add(finding.id);
      else next.delete(finding.id);
      return next;
    });
    if (!activeMemory) return;
    const signature = findingSignature(finding);
    const records = activeMemory.findings.map((record) => findingSignature(record.finding) === signature
      ? { ...record, reviewed: nextReviewed }
      : record);
    if (!records.some((record) => findingSignature(record.finding) === signature)) {
      records.push({ finding, provider: analysis?.provider ?? "rules", status: findingStatuses[finding.id] ?? "new", reviewed: nextReviewed });
    }
    saveMemory({ ...activeMemory, findings: records });
  }

  function dismissTimelineEvent(eventId: string) {
    setDismissedIds((current) => new Set(current).add(eventId));
    if (activeMemory) saveMemory({
      ...activeMemory,
      dismissedTimelineIds: [...new Set([...activeMemory.dismissedTimelineIds, eventId])].slice(-500),
    });
  }

  function toggleTimelineEvidence(eventId: string) {
    setExpandedTimelineIds((current) => {
      const next = new Set(current);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  }

  const messages = conversation?.messages ?? [];
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const activeMemory = conversation?.source === "import" && memory?.conversationId === conversation.id ? memory : null;
  const memoryRecords = activeMemory?.findings ?? [];
  const findingMap = new Map(memoryRecords.map(({ finding }) => [finding.id, finding]));
  for (const finding of analysis?.findings ?? []) findingMap.set(finding.id, finding);
  const allFindings = [...findingMap.values()].filter((finding) =>
    finding.evidence.length > 0 && finding.evidence.every(({ messageId }) => messagesById.has(messageId)),
  );
  const recordById = new Map(memoryRecords.map((record) => [record.finding.id, record]));
  const getStatus = (id: string): FindingStatus => findingStatuses[id] ?? recordById.get(id)?.status ?? "new";
  const isReviewed = (id: string): boolean => reviewedIds.has(id) || recordById.get(id)?.reviewed === true;
  const filteredFindings = allFindings.filter((finding) => {
    if (categoryFilter !== "all" && finding.category !== categoryFilter) return false;
    if (priorityFilter !== "all" && finding.priority !== priorityFilter) return false;
    const isResolved = getStatus(finding.id) === "completed";
    if (statusFilter === "unresolved" && isResolved) return false;
    if (statusFilter === "resolved" && !isResolved) return false;
    return true;
  });
  const unresolvedCount = allFindings.filter(({ id }) => getStatus(id) !== "completed").length;
  const resolvedCount = allFindings.length - unresolvedCount;
  const rejectedIssues: AnalysisIssue[] = analysis?.issues ?? [];
  const visibleTimeline = activeMemory?.timeline.filter((event) => !dismissedIds.has(event.id)) ?? [];
  const upcomingDeadlines = allFindings.filter((finding) =>
    getStatus(finding.id) !== "completed" && isUpcomingConfirmedDeadline(finding, messagesById),
  );
  const activeTasks = allFindings.filter((finding) => finding.category === "task" && getStatus(finding.id) !== "completed");
  const blockedItems = allFindings.filter((finding) =>
    getStatus(finding.id) === "blocked" || finding.category === "blocker" && getStatus(finding.id) !== "completed",
  );
  const pendingDecisions = allFindings.filter((finding) =>
    decisionNeedsConfirmation(finding, messagesById) && getStatus(finding.id) !== "completed",
  );
  function openFindingEvidence(findingId: string) {
    setExpandedIds((current) => new Set(current).add(findingId));
  }

  function toggleSet(setter: (value: Set<string>) => void, current: Set<string>, id: string) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="wordmark" href="#top" aria-label="Signalback home">
          <span className="brand-mark" aria-hidden="true"><span /></span>
          <span>signalback</span>
        </a>
        <div className="topbar-right">
          <span className={`local-badge${analysisMode === "gemini" ? " remote-mode" : ""}`}>
            <span aria-hidden="true">●</span>
            {analysis?.provider === "gemini"
              ? "Gemini analysis · remote"
              : analysisMode === "gemini" && error
                ? "Gemini unavailable · results retained"
                : analysisMode === "gemini" && busy && conversation
                  ? "Gemini analysis in progress"
                  : analysisMode === "gemini"
                    ? "Gemini selected · not sent"
                    : "Local rule-based analysis"}
          </span>
          <a className="topbar-link" href="#how-it-works">How it works <span aria-hidden="true">↗</span></a>
        </div>
      </header>

      <section className="intro" id="top">
        <div className="intro-copy">
          <p className="eyebrow"><span /> CONVERSATION INTELLIGENCE</p>
          <h1>Find the signal.<br /><em>Know your next move.</em></h1>
          <p className="intro-description">The important things don’t always arrive unread. Catch the decisions, deadlines, and blockers buried in the scroll.</p>
        </div>
        <div className="intro-index" aria-hidden="true">
          <span>01 <i>—</i> 03</span>
          <span className="index-label">CHANGE · IMPACT · NEXT</span>
        </div>
      </section>

      <div className="workspace">
        <aside className="source-rail" aria-label="Conversation source">
          <div className="rail-heading">
            <span className="section-index">01</span>
            <div><h2>Your conversation</h2><p>Start with a sample or bring your own.</p></div>
          </div>

          <button className="sample-button" type="button" onClick={handleSample} disabled={busy}>
            <span className="sample-icon" aria-hidden="true">✳</span>
            <span className="sample-text"><strong>Explore the sample</strong><small>A project handoff, with a twist</small></span>
            <span className="button-arrow" aria-hidden="true">↗</span>
          </button>

          <div className="import-card">
            <div className="import-icon" aria-hidden="true">↑</div>
            <h3>Import a chat</h3>
            <p>Choose a .txt export in Signalback’s supported format.</p>
            <input
              className="visually-hidden-input"
              id="conversation-file"
              ref={importRef}
              type="file"
              disabled={busy || !memoryReady}
              accept=".txt,text/plain"
              aria-describedby="import-format"
              onChange={handleImport}
            />
            <label className={`import-button${busy || !memoryReady ? " disabled" : ""}`} htmlFor="conversation-file" aria-disabled={busy || !memoryReady}>
              Choose .txt file <span aria-hidden="true">↑</span>
            </label>
            <p id="import-format" className="format-note">YYYY-MM-DD, HH:mm - Sender: message<br />Up to 250,000 characters · multiline supported</p>
          </div>

          {pendingImport && (
            <div className="memory-match-prompt" role="group" aria-labelledby="memory-match-title">
              <h3 id="memory-match-title">Is this the saved conversation?</h3>
              <p>There is not enough shared message evidence to match it confidently. Compare anyway, or start a separate conversation. Starting new replaces saved memory only after analysis succeeds.</p>
              <button type="button" onClick={() => resolvePendingImport("compare")}>Compare with saved memory</button>
              <button type="button" onClick={() => resolvePendingImport("new")}>Start new conversation</button>
            </div>
          )}

          {memoryNotice && <p className="memory-notice" role="status">{memoryNotice}</p>}

          {memory && (
            <div className="saved-memory-panel">
              <div><span className="meta-label">BROWSER MEMORY</span><strong>Conversation saved on this device</strong><small>Last checked {new Date(memory.lastAnalyzedAt).toLocaleString()}</small></div>
              {confirmDelete ? (
                <div className="memory-delete-confirm" role="group" aria-label="Confirm deleting saved conversation">
                  <span>Delete saved messages, findings, and statuses?</span>
                  <button type="button" onClick={deleteSavedMemory}>Delete memory</button>
                  <button type="button" onClick={() => setConfirmDelete(false)}>Keep it</button>
                </div>
              ) : (
                <button className="memory-delete-button" type="button" onClick={() => setConfirmDelete(true)}>Delete saved memory</button>
              )}
            </div>
          )}

          <div className="analysis-mode-card">
            <label className="mode-label" htmlFor="analysis-mode">ANALYSIS MODE</label>
            <select
              id="analysis-mode"
              value={analysisMode}
              disabled={busy}
              onChange={(event) => selectAnalysisMode(event.target.value as AnalysisMode)}
            >
              <option value="rules">Local rules · browser only</option>
              <option value="gemini">Google Gemini · remote</option>
            </select>
            {analysisMode === "gemini" ? (
              <div className="remote-consent-panel">
                <p><strong>Remote analysis sends conversation content to Google.</strong> Message text and sender/timestamp metadata are sent to Google’s Gemini service through Signalback’s server. The API key remains server-side. Google’s handling is subject to its service terms and policies.</p>
                <label className="consent-check">
                  <input type="checkbox" checked={remoteConsent} onChange={(event) => setRemoteConsent(event.target.checked)} />
                  <span>I understand and want to send this conversation to Google for analysis.</span>
                </label>
                <button className="gemini-button" type="button" disabled={!conversation || !remoteConsent || busy} onClick={() => conversation && void runGemini(conversation)}>
                  {busy ? "Analyzing with Gemini…" : "Analyze with Gemini"} <span aria-hidden="true">↗</span>
                </button>
              </div>
            ) : (
              <p className="mode-explanation">Deterministic rules run in this browser. Chat text is not sent to an AI provider.</p>
            )}
          </div>

          {conversation && (
            <div className="conversation-meta">
              <span className="meta-label">ACTIVE SOURCE</span>
              <strong>{conversation.source === "sample" ? "Sample conversation" : "Imported conversation"}</strong>
              <span>{messages.length} messages · {conversation.source === "import" && activeMemory ? "saved in this browser" : "current session"}</span>
            </div>
          )}

          <div className="privacy-note">
            <span className="privacy-symbol" aria-hidden="true">⌁</span>
            <p><strong>{analysisMode === "gemini" ? "Remote processing is opt-in." : analysis?.provider === "gemini" ? "This saved analysis was remote." : memory ? "Saved memory remains in this browser." : "Local rule-based analysis."}</strong>{analysisMode === "gemini" ? "Nothing is sent until you check consent and run Gemini. Local mode remains available." : analysis?.provider === "gemini" ? "This result was produced by sending conversation content to Google’s Gemini. No new request is sent unless you select Gemini, consent, and run it." : memory ? "Saved messages, findings, and statuses use this browser’s localStorage until you delete them. Browser storage is not encrypted." : "Analysis runs in this browser. Imported conversations are saved here only after analysis succeeds."}</p>
          </div>
        </aside>

        <section className="findings-area" aria-labelledby="findings-title">
          <div className="findings-heading">
            <div>
              <div className="section-kicker"><span className="section-index">02</span> THE BRIEFING</div>
              <h2 id="findings-title">What needs your attention<span className="heading-period">.</span></h2>
              <p className="heading-caption">WHAT CHANGED <span>→</span> WHY IT MATTERS <span>→</span> WHAT TO DO NEXT</p>
            </div>
            {conversation && analysis && (
              <div className="finding-total"><span className={`result-provider ${analysis.provider === "gemini" ? "gemini" : "rules"}`}>{analysis.provider === "gemini" ? "GEMINI · REMOTE" : "LOCAL RULES"}</span><strong>{unresolvedCount.toString().padStart(2, "0")}</strong><span>OPEN<br />FINDINGS</span></div>
            )}
          </div>

          {conversation?.source === "import" && activeMemory && analysis && !busy && (
            <section className="catchup-panel" aria-labelledby="catchup-title">
              <div className="memory-section-heading">
                <div><span className="section-kicker">MEMORY · 03</span><h3 id="catchup-title">Since your last check</h3></div>
                <span className="memory-timestamp">{new Date(activeMemory.lastImportedAt).toLocaleDateString()}</span>
              </div>
              {activeMemory.comparisonCount === 0 ? (
                <div className="memory-empty-state">
                  <strong>Your first catch-up is ready.</strong>
                  <p>This import is the starting baseline. Signalback will compare your next export with these saved messages and findings.</p>
                </div>
              ) : (
                <>
                  {activeMemory.lastNewMessageCount > 0 && (
                    <p className="observed-message-note">{activeMemory.lastNewMessageCount} message{activeMemory.lastNewMessageCount === 1 ? " was" : "s were"} newly observed in this export. The export does not establish when they arrived.</p>
                  )}
                  {visibleTimeline.length ? (
                    <div className="timeline-list">
                      {visibleTimeline.map((event) => (
                        <article className="timeline-item" key={event.id}>
                          <span className={`timeline-marker ${event.kind}`} aria-hidden="true" />
                          <div className="timeline-copy">
                            <div className="timeline-item-heading"><span>{event.kind === "still-open" ? "Still needs attention" : CATEGORY_LABEL[event.kind]}</span><DisplayBasis basis={event.basis} /></div>
                            <p className="timeline-change">{event.whatChanged}</p>
                            <p>{event.whyItMatters}</p>
                            <p className="timeline-next"><strong>Next:</strong> {event.whatToDoNext}</p>
                            <div className="timeline-actions">
                              <button type="button" aria-expanded={expandedTimelineIds.has(event.id)} onClick={() => toggleTimelineEvidence(event.id)}>{expandedTimelineIds.has(event.id) ? "Hide source messages" : `Open original evidence (${event.evidenceMessageIds.length})`}</button>
                              <button type="button" onClick={() => dismissTimelineEvent(event.id)}>Dismiss update</button>
                            </div>
                            {expandedTimelineIds.has(event.id) && (
                              <div className="timeline-evidence" aria-label="Original messages for this update">
                                {event.evidenceMessageIds.map((messageId) => messagesById.get(messageId)).filter((message): message is ChatMessage => Boolean(message)).map((message) => (
                                  <figure className="evidence-message" key={message.id}>
                                    <figcaption><span className="evidence-sender">{message.sender || "Unknown sender"}</span><time>{formatTimestamp(message)}</time></figcaption>
                                    <blockquote>{message.originalText}</blockquote>
                                  </figure>
                                ))}
                              </div>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="memory-empty-state"><strong>No new developments surfaced.</strong><p>Previously saved messages were retained when this export omitted them. An absent message is not treated as deleted.</p></div>
                  )}
                  {dismissedIds.size > 0 && <p className="dismissed-note">{dismissedIds.size} update{dismissedIds.size === 1 ? "" : "s"} dismissed from this view. Dismissal does not change task status.</p>}
                </>
              )}
              <p className="timeline-caveat">Timeline order uses message timestamps when available, otherwise source order. It cannot establish actual arrival time.</p>
            </section>
          )}

          {conversation && analysis && !busy && (
            <section className="attention-panel" aria-labelledby="attention-title">
              <div className="memory-section-heading"><div><span className="section-kicker">04 · OPEN ITEMS</span><h3 id="attention-title">Your attention</h3></div><span className="attention-total">{upcomingDeadlines.length + activeTasks.length + blockedItems.length + pendingDecisions.length}</span></div>
              {upcomingDeadlines.length + activeTasks.length + blockedItems.length + pendingDecisions.length === 0 ? (
                <p className="attention-empty">No explicit upcoming deadlines, open tasks, blockers, or decisions awaiting confirmation were identified.</p>
              ) : (
                <div className="attention-list">
                  {[...upcomingDeadlines, ...activeTasks, ...blockedItems, ...pendingDecisions]
                    .filter((finding, index, all) => all.findIndex((item) => item.id === finding.id) === index)
                    .map((finding) => (
                      <article className="attention-item" key={finding.id}>
                        <div><span className="attention-category">{CATEGORY_LABEL[finding.category]}</span><span className={`attention-status ${getStatus(finding.id)}`}>{getStatus(finding.id) === "new" ? "Open" : getStatus(finding.id)}</span></div>
                        <p>{finding.whatChanged}</p>
                        <button type="button" onClick={() => openFindingEvidence(finding.id)}>Open source evidence</button>
                      </article>
                    ))}
                </div>
              )}
            </section>
          )}

          {error && (
            <div className="message-banner error-banner" role="alert">
              <span aria-hidden="true">!</span><p>{error}</p>
              <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>×</button>
              {analysisMode === "gemini" && conversation && analysis && !busy && (
                <div className="fallback-actions">
                  <button type="button" onClick={() => void runGemini(conversation)} disabled={!remoteConsent}>Retry Gemini</button>
                  <button type="button" onClick={() => selectAnalysisMode("rules")}>Switch to local rules</button>
                </div>
              )}
            </div>
          )}

          {busy && (
            <div className="progress-panel" role="status" aria-live="polite">
              <span className="progress-mark" aria-hidden="true" />
              <div><strong>{conversation ? analysisMode === "gemini" ? "Finding the important turns with Gemini…" : "Finding the important turns…" : "Reading your conversation…"}</strong><span>{analysisMode === "gemini" ? "Conversation content is being sent to Google for remote analysis." : "Running local rule-based analysis on the active messages."}</span></div>
            </div>
          )}

          {rejectedIssues.length > 0 && !busy && (
            <div className="message-banner warning-banner" role="status">
              <span aria-hidden="true">!</span>
              <p>{rejectedIssues.length} candidate {rejectedIssues.length === 1 ? "finding was" : "findings were"} excluded because its fields or evidence references could not be verified.</p>
            </div>
          )}

          {!conversation && !busy && !error && (
            <div className="welcome-panel">
              <div className="welcome-art" aria-hidden="true"><span className="orbit orbit-one" /><span className="orbit orbit-two" /><span className="signal-core">S</span><span className="signal-spark">✳</span></div>
              <p className="eyebrow">A CLEARER WAY THROUGH THE SCROLL</p>
              <h3>Every thread has a turning point.</h3>
              <p>Load the sample to see how Signalback surfaces a shifted plan, a blocker, and the next move — each tied to the original message.</p>
              <button className="primary-button" type="button" onClick={handleSample}>Show me the signal <span aria-hidden="true">↗</span></button>
            </div>
          )}

          {conversation && analysis && !busy && (
            <>
              <div className="filter-bar" aria-label="Filter findings">
                <SelectFilter label="Category" value={categoryFilter} onChange={(value) => setCategoryFilter(value as CategoryFilter)}>
                  <option value="all">All categories</option>
                  {CATEGORIES.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
                </SelectFilter>
                <SelectFilter label="Priority" value={priorityFilter} onChange={(value) => setPriorityFilter(value as PriorityFilter)}>
                  <option value="all">All priorities</option>
                  <option value="high">High</option><option value="medium">Medium</option><option value="low">Lower</option>
                </SelectFilter>
                <SelectFilter label="Status" value={statusFilter} onChange={(value) => setStatusFilter(value as StatusFilter)}>
                  <option value="unresolved">Open ({unresolvedCount})</option>
                  <option value="resolved">Completed ({resolvedCount})</option>
                  <option value="all">All findings ({allFindings.length})</option>
                </SelectFilter>
                <span className="filter-count">{filteredFindings.length} SHOWN</span>
              </div>

              {filteredFindings.length > 0 ? (
                <div className="finding-list">
                  {filteredFindings.map((finding, index) => (
                    <FindingsCard
                      key={finding.id}
                      finding={finding}
                      messages={messagesById}
                      status={getStatus(finding.id)}
                      reviewed={isReviewed(finding.id)}
                      savedProvider={analysis.findings.some(({ id }) => id === finding.id) ? undefined : recordById.get(finding.id)?.provider}
                      expanded={expandedIds.has(finding.id)}
                      onStatusChange={(status) => updateFindingStatus(finding, status)}
                      onToggleReviewed={() => toggleReviewed(finding)}
                      onToggleEvidence={() => toggleSet(setExpandedIds, expandedIds, finding.id)}
                    />
                  ))}
                </div>
              ) : (
                <div className="empty-panel">
                  <span aria-hidden="true">{allFindings.length === 0 ? "✳" : "✓"}</span>
                  <h3>{allFindings.length === 0 ? "Nothing surfaced yet." : statusFilter === "unresolved" && unresolvedCount === 0 ? "You’re all caught up." : "No findings match these filters."}</h3>
                  <p>{allFindings.length === 0 ? "The current rule set only surfaces messages with explicit signals. Try another conversation or review the rules as the product grows." : "Adjust a filter to see more of this conversation."}</p>
                  {statusFilter !== "all" && allFindings.length > 0 && <button className="text-button" type="button" onClick={() => setStatusFilter("all")}>View all findings <span aria-hidden="true">→</span></button>}
                </div>
              )}

              <p className="results-footnote">Rule-based analysis can miss context or paraphrases. Evidence references point to source messages; they do not guarantee every interpretation is correct.</p>
            </>
          )}

          {conversation && error && !analysis && !busy && (
            <div className="empty-panel analysis-failure">
              <span aria-hidden="true">↻</span><h3>Analysis didn’t finish.</h3>
              <p>Your conversation is still active in memory. Choose how you want to continue.</p>
              {analysisMode === "gemini" ? (
                <>
                  <button className="text-button" type="button" disabled={!remoteConsent} onClick={() => void runGemini(conversation)}>Retry Gemini <span aria-hidden="true">→</span></button>
                  <button className="text-button" type="button" onClick={() => selectAnalysisMode("rules")}>Switch to local rules <span aria-hidden="true">→</span></button>
                </>
              ) : (
                <button className="text-button" type="button" onClick={() => void runLocal(conversation)}>Retry local analysis <span aria-hidden="true">→</span></button>
              )}
            </div>
          )}
        </section>
      </div>

      <footer className="page-footer" id="how-it-works">
        <span>signalback <i>·</i> Find the signal. Know your next move.</span>
        <span>{analysis?.provider === "gemini" ? "Last analysis used Gemini · conversation sent to Google" : analysisMode === "gemini" ? "Gemini selected · no request sent yet" : "Local rule-based analysis · browser only"}</span>
      </footer>
      <span className="visually-hidden" role="status" aria-live="polite">{announcement}</span>
    </main>
  );
}
