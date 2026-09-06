import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";

import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentMode,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentProvider,
  AgentProviderNotice,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSlashCommand,
  AgentStreamEvent,
} from "../../agent-sdk-types.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { materializeProviderImage } from "../provider-image-output.js";
import { runProviderTurn } from "../provider-runner.js";
import {
  encodeHerdrAttachedPiHandle,
  HERDR_ATTACHED_PI_RUNTIME,
  toPersistedHerdrAttachedPiMetadata,
  validateHerdrAttachedPiTarget,
  type HerdrAttachedPiMetadata,
} from "./herdr-attachment.js";
import type { HerdrAgent, HerdrClient } from "./herdr-client.js";
import { resolvePaseoHome } from "../../../paseo-home.js";
import {
  mapPiNativeHistoryEvents,
  readPiNativeHistory,
  selectPiNativeHistoryEventsAfter,
  type PiNativeHistoryEvent,
} from "./native-history.js";

const PI_PROVIDER = "pi";
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const MAX_HERDR_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_HERDR_MIME_TYPE_LENGTH = 255;
const MIME_TYPE_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const SUPPORTED_HERDR_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/bmp",
  "image/gif",
  "image/heic",
  "image/heif",
  "image/jpeg",
  "image/png",
  "image/tiff",
  "image/webp",
]);

class HerdrAttachmentIdentityError extends Error {}

const HERDR_ATTACHED_PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: false,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

interface HerdrAttachedPiSessionOptions {
  herdrClient: HerdrClient;
  metadata: HerdrAttachedPiMetadata;
  config: { cwd: string; model?: string; thinkingOptionId?: string; modeId?: string };
  pollIntervalMs?: number;
  uploadsRoot?: string;
}

interface ActiveTurn {
  turnId: string;
  promptText: string;
  clientMessageId: string | null;
  baselineNativeEntryId: string | null;
  submittedNativeEntryId: string | null;
  observedNativeEntry: boolean;
}

export class HerdrAttachedPiSession implements AgentSession {
  readonly provider: AgentProvider = PI_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = HERDR_ATTACHED_PI_CAPABILITIES;
  readonly features?: AgentFeature[];

  private readonly herdrClient: HerdrClient;
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly config: HerdrAttachedPiSessionOptions["config"];
  private metadata: HerdrAttachedPiMetadata;
  private readonly pollIntervalMs: number;
  private readonly uploadsRoot: string;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollInFlight = false;
  private closed = false;
  private activeTurn: ActiveTurn | null = null;
  private externalTurnId: string | null = null;
  private offlineError: string | null = null;
  private readonly persistenceCursorByEvent = new WeakMap<AgentStreamEvent, string | null>();

  constructor(options: HerdrAttachedPiSessionOptions) {
    this.herdrClient = options.herdrClient;
    this.metadata = toPersistedHerdrAttachedPiMetadata(options.metadata);
    this.config = options.config;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.uploadsRoot = options.uploadsRoot ?? join(resolvePaseoHome(), "uploads");
  }

  get id(): string | null {
    return this.metadata.nativeSessionId;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: () => this.metadata.nativeSessionId,
      reduceFinalText: ({ current, item }) =>
        item.type === "assistant_message" ? `${current}${item.text}` : current,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurn) {
      throw new Error("A Herdr-attached Pi turn is already active");
    }
    const target = await this.verifyTarget();
    this.offlineError = null;
    if (isBlockedStatus(target.status)) {
      throw new Error(`Herdr target ${this.metadata.herdrTarget} is blocked`);
    }
    if (this.externalTurnId || isRunningStatus(target.status)) {
      throw new Error(`Herdr target ${this.metadata.herdrTarget} is already running`);
    }

    const promptText = await renderHerdrPrompt(prompt, this.uploadsRoot);
    const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
    this.assertNativeHistoryMatches(history);
    const turnId = randomUUID();
    this.activeTurn = {
      turnId,
      promptText,
      clientMessageId: options?.clientMessageId ?? null,
      baselineNativeEntryId: history.latestEntryId,
      submittedNativeEntryId: null,
      observedNativeEntry: false,
    };

    try {
      await this.herdrClient.prompt(this.metadata.herdrTarget, promptText);
    } catch (error) {
      this.activeTurn = null;
      throw error;
    }

    if (this.subscribers.size > 0) {
      this.clearPollTimer();
      this.schedulePoll(0);
    }
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    this.schedulePoll(this.pollIntervalMs);
    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0) {
        this.clearPollTimer();
      }
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    await this.verifyTarget();
    const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
    this.assertNativeHistoryMatches(history);
    const events = selectPiNativeHistoryEventsAfter(
      mapPiNativeHistoryEvents(history, this.provider),
      this.metadata.lastSyncedNativeEntryId,
    );
    this.rememberLastSyncedEntry(events);
    for (const { event } of events) {
      yield event;
    }
  }

  async reconcileHistory(): Promise<void> {
    if (this.closed || this.pollInFlight) {
      return;
    }
    this.pollInFlight = true;
    try {
      const target = await this.verifyTarget();
      this.reconcileHerdrStatus(target);
      const history = await readPiNativeHistory(this.metadata.nativeSessionFile);
      this.assertNativeHistoryMatches(history);
      const events = selectPiNativeHistoryEventsAfter(
        mapPiNativeHistoryEvents(history, this.provider),
        this.metadata.lastSyncedNativeEntryId,
      );
      const afterTurnBaseline = this.nativeEntryIdsAfterTurnBaseline(history.entries);
      this.emitNativeEvents(events, afterTurnBaseline);
      this.observeNativeProgressAfterSubmittedEntry(history.entries);
      this.rememberLastSyncedEntry(events);
      this.completeActiveTurnIfIdle(target.status);
      this.completeExternalTurnIfIdle(target.status);
      this.offlineError = null;
    } catch (error) {
      if (error instanceof HerdrAttachmentIdentityError) {
        this.markOffline(error);
      } else {
        this.offlineError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      this.pollInFlight = false;
      if (!this.closed && this.subscribers.size > 0) {
        this.schedulePoll(this.pollIntervalMs);
      }
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const target = await this.verifyTarget();
    return {
      provider: this.provider,
      sessionId: this.metadata.nativeSessionId,
      model: this.config.model ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
      modeId: this.config.modeId ?? null,
      extra: {
        runtime: HERDR_ATTACHED_PI_RUNTIME,
        herdrSession: this.metadata.herdrSession,
        herdrTarget: this.metadata.herdrTarget,
        herdrStatus: target.status,
        nativeSessionFile: this.metadata.nativeSessionFile,
      },
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async setMode(_modeId: string): Promise<void | AgentProviderNotice> {
    throw new Error("Herdr-attached Pi sessions do not support mode changes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [];
  }

  async respondToPermission(_requestId: string, _response: AgentPermissionResponse): Promise<void> {
    throw new Error("Herdr-attached Pi sessions do not expose permissions in Paseo");
  }

  describePersistence(event?: AgentStreamEvent): AgentPersistenceHandle | null {
    const metadata = toPersistedHerdrAttachedPiMetadata(this.metadata);
    if (event && this.persistenceCursorByEvent.has(event)) {
      const eventCursor = this.persistenceCursorByEvent.get(event);
      if (eventCursor) {
        metadata.lastSyncedNativeEntryId = eventCursor;
      } else {
        delete metadata.lastSyncedNativeEntryId;
      }
    }
    return {
      provider: this.provider,
      sessionId: encodeHerdrAttachedPiHandle(metadata),
      nativeHandle: this.metadata.nativeSessionFile,
      metadata,
    };
  }

  async interrupt(): Promise<void> {
    await this.verifyTarget();
    await this.herdrClient.interrupt(this.metadata.herdrTarget);
    const turnId = this.activeTurn?.turnId ?? this.externalTurnId;
    this.activeTurn = null;
    this.externalTurnId = null;
    if (turnId) {
      this.emit({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearPollTimer();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return [];
  }

  async setModel(_modelId: string | null): Promise<void> {
    throw new Error("Herdr-attached Pi sessions do not support model changes from Paseo");
  }

  async setThinkingOption(_thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    throw new Error("Herdr-attached Pi sessions do not support thinking changes from Paseo");
  }

  private async verifyTarget(): Promise<HerdrAgent> {
    const target = await this.herdrClient.getAgent(this.metadata.herdrTarget);
    const validation = validateHerdrAttachedPiTarget(this.metadata, target);
    if (!validation.ok) {
      throw new HerdrAttachmentIdentityError(validation.reason);
    }
    return target;
  }

  private assertNativeHistoryMatches(history: {
    sessionId: string;
    cwd: string;
    sessionFile: string;
  }): void {
    if (history.sessionId !== this.metadata.nativeSessionId) {
      throw new HerdrAttachmentIdentityError(
        `Native Pi session changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
    if (history.sessionFile !== this.metadata.nativeSessionFile) {
      throw new HerdrAttachmentIdentityError(
        `Native Pi session file changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
    if (history.cwd !== this.metadata.cwd) {
      throw new HerdrAttachmentIdentityError(
        `Working directory changed for Herdr target ${this.metadata.herdrTarget}`,
      );
    }
  }

  private reconcileHerdrStatus(target: HerdrAgent): void {
    if (isBlockedStatus(target.status)) {
      throw new HerdrAttachmentIdentityError(
        `Herdr target ${this.metadata.herdrTarget} is blocked`,
      );
    }
    if (!this.activeTurn && !this.externalTurnId && isRunningStatus(target.status)) {
      this.externalTurnId = randomUUID();
      this.emit({ type: "turn_started", provider: this.provider, turnId: this.externalTurnId });
    }
  }

  private emitNativeEvents(
    events: readonly PiNativeHistoryEvent[],
    afterTurnBaseline: ReadonlySet<string> | null,
  ): void {
    let committedCursor = this.metadata.lastSyncedNativeEntryId ?? null;
    for (const [index, nativeEvent] of events.entries()) {
      const event = this.correlateActiveUserMessage(
        nativeEvent,
        afterTurnBaseline?.has(nativeEvent.entryId) ?? true,
      );
      const completesEntry = events[index + 1]?.entryId !== nativeEvent.entryId;
      const eventCursor = completesEntry ? nativeEvent.entryId : committedCursor;
      this.persistenceCursorByEvent.set(event, eventCursor);
      this.emit(event);
      if (completesEntry) {
        committedCursor = nativeEvent.entryId;
      }
      if (
        this.activeTurn?.submittedNativeEntryId &&
        nativeEvent.entryId !== this.activeTurn.submittedNativeEntryId
      ) {
        this.activeTurn.observedNativeEntry = true;
      }
    }
  }

  private nativeEntryIdsAfterTurnBaseline(
    entries: readonly { entryId: string }[],
  ): ReadonlySet<string> | null {
    const baseline = this.activeTurn?.baselineNativeEntryId;
    if (!this.activeTurn) {
      return null;
    }
    if (!baseline) {
      return new Set(entries.map((entry) => entry.entryId));
    }
    const baselineIndex = entries.findIndex((entry) => entry.entryId === baseline);
    if (baselineIndex === -1) {
      throw new Error(`Native Pi history no longer contains turn baseline ${baseline}`);
    }
    return new Set(entries.slice(baselineIndex + 1).map((entry) => entry.entryId));
  }

  private observeNativeProgressAfterSubmittedEntry(entries: readonly { entryId: string }[]): void {
    const active = this.activeTurn;
    if (!active?.submittedNativeEntryId) {
      return;
    }
    const submittedIndex = entries.findIndex(
      (entry) => entry.entryId === active.submittedNativeEntryId,
    );
    if (submittedIndex >= 0 && submittedIndex < entries.length - 1) {
      active.observedNativeEntry = true;
    }
  }

  private correlateActiveUserMessage(
    nativeEvent: PiNativeHistoryEvent,
    afterTurnBaseline: boolean,
  ): AgentStreamEvent {
    const active = this.activeTurn;
    if (
      !active ||
      !afterTurnBaseline ||
      nativeEvent.event.type !== "timeline" ||
      nativeEvent.event.item.type !== "user_message" ||
      nativeEvent.event.item.clientMessageId ||
      nativeEvent.event.item.text !== active.promptText
    ) {
      return nativeEvent.event;
    }
    active.submittedNativeEntryId = nativeEvent.entryId;
    if (!active.clientMessageId) {
      return nativeEvent.event;
    }
    return {
      ...nativeEvent.event,
      turnId: active.turnId,
      item: {
        ...nativeEvent.event.item,
        clientMessageId: active.clientMessageId,
      },
    };
  }

  private rememberLastSyncedEntry(events: readonly PiNativeHistoryEvent[]): void {
    const latest = events.at(-1)?.entryId;
    if (latest) {
      this.metadata = { ...this.metadata, lastSyncedNativeEntryId: latest };
    }
  }

  private completeActiveTurnIfIdle(status: string | null): void {
    if (!this.activeTurn || !this.activeTurn.observedNativeEntry || !isIdleStatus(status)) {
      return;
    }
    const { turnId } = this.activeTurn;
    this.activeTurn = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  private completeExternalTurnIfIdle(status: string | null): void {
    if (!this.externalTurnId || !isIdleStatus(status)) {
      return;
    }
    const turnId = this.externalTurnId;
    this.externalTurnId = null;
    this.emit({ type: "turn_completed", provider: this.provider, turnId });
  }

  private markOffline(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (this.offlineError === message) {
      return;
    }
    this.offlineError = message;
    const turnId = this.activeTurn?.turnId ?? this.externalTurnId ?? undefined;
    this.activeTurn = null;
    this.externalTurnId = null;
    this.emit({
      type: "turn_failed",
      provider: this.provider,
      error: message,
      ...(turnId ? { turnId } : {}),
    });
  }

  private schedulePoll(delayMs: number): void {
    if (this.closed || this.pollTimer) {
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      void this.reconcileHistory();
    }, delayMs);
  }

  private clearPollTimer(): void {
    if (!this.pollTimer) {
      return;
    }
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  private emit(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

async function renderHerdrPrompt(prompt: AgentPromptInput, uploadsRoot: string): Promise<string> {
  if (typeof prompt === "string") {
    return prompt;
  }
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "image") {
      const image = validateHerdrImageAttachment(block);
      const materialized = materializeProviderImage(image);
      parts.push(
        [
          "[Image attachment downgraded to a file reference because Herdr-attached Pi prompt injection supports text only.]",
          `Saved path: ${materialized.path}`,
        ].join("\n"),
      );
    } else if (block.type === "uploaded_file") {
      const uploadedFile = await validateHerdrUploadedFile(block, uploadsRoot);
      parts.push(
        [
          "[File attachment downgraded to a file reference because Herdr-attached Pi prompt injection supports text only.]",
          `File: ${block.fileName}`,
          `Saved path: ${uploadedFile.path}`,
          `MIME: ${uploadedFile.mimeType}`,
          `Size: ${block.size} bytes`,
        ].join("\n"),
      );
    } else {
      parts.push(renderPromptAttachmentAsText(block));
    }
  }
  return parts.filter((part) => part.trim().length > 0).join("\n\n");
}

async function validateHerdrUploadedFile(
  file: Extract<AgentPromptContentBlock, { type: "uploaded_file" }>,
  uploadsRoot: string,
): Promise<{ path: string; mimeType: string }> {
  if (file.size > MAX_HERDR_ATTACHMENT_BYTES) {
    throw new Error(`File attachment exceeds the ${MAX_HERDR_ATTACHMENT_BYTES}-byte limit`);
  }
  const mimeType = file.mimeType.trim().toLowerCase();
  if (mimeType.length > MAX_HERDR_MIME_TYPE_LENGTH || !MIME_TYPE_PATTERN.test(mimeType)) {
    throw new Error("Uploaded file has an invalid MIME type");
  }
  const [canonicalRoot, canonicalPath] = await Promise.all([
    realpath(uploadsRoot).catch(() => null),
    realpath(file.path).catch(() => null),
  ]);
  if (!canonicalRoot || !canonicalPath) {
    throw new Error("Uploaded file is not available in Paseo upload storage");
  }

  const pathWithinRoot = relative(canonicalRoot, canonicalPath);
  if (
    pathWithinRoot === "" ||
    pathWithinRoot === ".." ||
    pathWithinRoot.startsWith(`..${sep}`) ||
    basename(canonicalPath) !== file.fileName ||
    basename(dirname(canonicalPath)) !== file.id
  ) {
    throw new Error("Uploaded file path is not a trusted Paseo upload");
  }

  const metadata = await stat(canonicalPath);
  if (!metadata.isFile() || metadata.size !== file.size) {
    throw new Error("Uploaded file metadata does not match Paseo upload storage");
  }
  return { path: canonicalPath, mimeType };
}

function validateHerdrImageAttachment(
  image: Extract<AgentPromptContentBlock, { type: "image" }>,
): Extract<AgentPromptContentBlock, { type: "image" }> {
  const mimeType = image.mimeType.trim().toLowerCase();
  if (!SUPPORTED_HERDR_IMAGE_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported image attachment MIME type: ${image.mimeType}`);
  }

  const maxBase64Length = Math.ceil(MAX_HERDR_ATTACHMENT_BYTES / 3) * 4;
  if (image.data.length > maxBase64Length) {
    throw new Error(`Image attachment exceeds the ${MAX_HERDR_ATTACHMENT_BYTES}-byte limit`);
  }
  if (
    image.data.length === 0 ||
    image.data.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data)
  ) {
    throw new Error("Image attachment is not valid base64 data");
  }

  let paddingBytes = 0;
  if (image.data.endsWith("==")) {
    paddingBytes = 2;
  } else if (image.data.endsWith("=")) {
    paddingBytes = 1;
  }
  const decodedBytes = (image.data.length / 4) * 3 - paddingBytes;
  if (decodedBytes > MAX_HERDR_ATTACHMENT_BYTES) {
    throw new Error(`Image attachment exceeds the ${MAX_HERDR_ATTACHMENT_BYTES}-byte limit`);
  }
  return { ...image, mimeType };
}

function isRunningStatus(status: string | null): boolean {
  return /running|working|busy|streaming|initializing/i.test(status ?? "");
}

function isIdleStatus(status: string | null): boolean {
  return /idle|done|complete|completed|finished/i.test(status ?? "");
}

function isBlockedStatus(status: string | null): boolean {
  return /blocked|permission|attention|waiting/i.test(status ?? "");
}
