import { spawn } from "node:child_process";

export interface HerdrAgent {
  target: string;
  id?: string;
  name?: string;
  kind: string | null;
  status: string | null;
  ownStatus?: string;
  cwd: string | null;
  paneId?: string;
  tabId?: string;
  herdrWorkspaceId?: string;
  parentTarget?: string;
  taskLabel?: string;
  topic?: string;
  workspaceLabel?: string;
  tabLabel?: string;
  paneLabel?: string;
  nativeSessionId: string | null;
  nativeSessionFile: string | null;
  lastActivityAt: Date | null;
}

export interface HerdrClient {
  listAgents(): Promise<HerdrAgent[]>;
  getAgent(target: string): Promise<HerdrAgent>;
  prompt(target: string, text: string): Promise<void>;
  interrupt(target: string): Promise<void>;
  read(target: string, options?: { lines?: number }): Promise<string>;
}

interface HerdrCliClientOptions {
  command?: [string, ...string[]];
  session?: string;
  timeoutMs?: number;
  interruptKeys?: string[];
}

interface CommandResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_INTERRUPT_KEYS = ["ctrl+c"];

export class HerdrCliClient implements HerdrClient {
  private readonly command: [string, ...string[]];
  private readonly session?: string;
  private readonly timeoutMs: number;
  private readonly interruptKeys: string[];

  constructor(options: HerdrCliClientOptions = {}) {
    this.command = options.command ?? ["herdr"];
    this.session = options.session?.trim() || undefined;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.interruptKeys = options.interruptKeys?.length
      ? options.interruptKeys
      : DEFAULT_INTERRUPT_KEYS;
  }

  async listAgents(): Promise<HerdrAgent[]> {
    const [agentsResult, workspaces, tabs, panes] = await Promise.all([
      this.run(["agent", "list"]),
      this.readOptionalPayload(["workspace", "list"]),
      this.readOptionalPayload(["tab", "list"]),
      this.readOptionalPayload(["pane", "list"]),
    ]);
    const agents = parseHerdrAgentListPayload(parseJsonOutput(agentsResult.stdout));
    return enrichHerdrPresentation(agents, { workspaces, tabs, panes });
  }

  async getAgent(target: string): Promise<HerdrAgent> {
    const result = await this.run(["agent", "get", target]);
    return parseHerdrAgentPayload(parseJsonOutput(result.stdout));
  }

  async prompt(target: string, text: string): Promise<void> {
    await this.run(["agent", "prompt", target, text]);
  }

  async interrupt(target: string): Promise<void> {
    await this.run(["agent", "send-keys", target, ...this.interruptKeys]);
  }

  async read(target: string, options: { lines?: number } = {}): Promise<string> {
    const lines = options.lines ?? 80;
    const result = await this.run([
      "agent",
      "read",
      target,
      "--source",
      "recent-unwrapped",
      "--lines",
      String(lines),
      "--format",
      "text",
    ]);
    return result.stdout;
  }

  private async readOptionalPayload(args: string[]): Promise<unknown | null> {
    try {
      const result = await this.run(args);
      return parseJsonOutput(result.stdout);
    } catch {
      return null;
    }
  }

  private async run(args: string[]): Promise<CommandResult> {
    const fullArgs = [...this.command.slice(1), ...args];
    if (this.session) {
      fullArgs.push("--session", this.session);
    }

    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(this.command[0], fullArgs, {
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Herdr command timed out after ${this.timeoutMs}ms: ${args.join(" ")}`));
      }, this.timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code === 0) {
          resolve({ stdout, stderr });
          return;
        }
        reject(
          new Error(
            `Herdr command failed (${signal ?? code ?? "unknown"}): ${args.join(" ")}${stderr ? `\n${stderr.trim()}` : ""}`,
          ),
        );
      });
    });
  }
}

export function parseHerdrAgentListPayload(payload: unknown): HerdrAgent[] {
  const root = unwrapHerdrResult(payload);
  const agentField = readField(root, "agents");
  const agents = Array.isArray(agentField) ? agentField : root;
  if (!Array.isArray(agents)) {
    return [];
  }
  return agents.flatMap((agent) => {
    const parsed = parseHerdrAgentRecord(agent);
    return parsed ? [parsed] : [];
  });
}

export function parseHerdrAgentPayload(payload: unknown): HerdrAgent {
  const root = unwrapHerdrResult(payload);
  const agent = readRecordField(root, "agent") ?? root;
  const parsed = parseHerdrAgentRecord(agent);
  if (!parsed) {
    throw new Error("Herdr agent payload did not contain an agent");
  }
  return parsed;
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error("Herdr command returned no output");
  }
  return JSON.parse(trimmed) as unknown;
}

function parseHerdrAgentRecord(value: unknown): HerdrAgent | null {
  if (!isRecord(value)) {
    return null;
  }

  const agentSession =
    readRecordField(value, "agent_session") ??
    readRecordField(value, "agentSession") ??
    readRecordField(value, "session");
  const target = readFirstString(value, ["target", "name", "alias", "id", "pane_id", "paneId"]);
  if (!target) {
    return null;
  }

  const id = readString(value, "id");
  const name = readString(value, "name");
  const paneId = readFirstString(value, ["paneId", "pane_id"]);
  const tabId = readFirstString(value, ["tabId", "tab_id"]);
  const herdrWorkspaceId =
    readFirstString(value, [
      "herdrWorkspaceId",
      "herdr_workspace_id",
      "workspaceId",
      "workspace_id",
    ]) ?? (tabId ? parseWorkspaceIdFromHerdrId(tabId) : null);
  const parentTarget = readFirstString(value, [
    "parentTarget",
    "parent_target",
    "parentPaneId",
    "parent_pane_id",
    "parentId",
    "parent_id",
  ]);
  const labels = readHerdrPresentationLabels(value);
  const aggregateStatus = readFirstString(value, ["status", "lifecycle", "state"]);
  const agentStatus = readString(value, "agent_status");
  const ownStatus =
    readFirstString(value, ["ownStatus", "own_status", "selfStatus", "self_status"]) ??
    (aggregateStatus && agentStatus ? agentStatus : null);
  const nativeSessionFile = readFirstString(
    value,
    ["nativeSessionFile", "native_session_file", "session_file", "sessionFile"],
    agentSession,
    ["file", "path", "sessionFile", "session_file", "value"],
  );
  return {
    target,
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    kind: readFirstString(value, ["kind", "agent_kind", "agent", "provider", "type"]),
    status: aggregateStatus ?? agentStatus,
    ...(ownStatus ? { ownStatus } : {}),
    cwd: readFirstString(
      value,
      ["foreground_cwd", "cwd", "working_directory", "workingDirectory"],
      agentSession,
      ["cwd"],
    ),
    ...(paneId ? { paneId } : {}),
    ...(tabId ? { tabId } : {}),
    ...(herdrWorkspaceId ? { herdrWorkspaceId } : {}),
    ...(parentTarget ? { parentTarget } : {}),
    ...labels,
    nativeSessionId:
      readFirstString(value, ["nativeSessionId", "native_session_id", "session_id"], agentSession, [
        "id",
        "sessionId",
        "session_id",
      ]) ?? derivePiSessionIdFromFile(nativeSessionFile),
    nativeSessionFile,
    lastActivityAt: readDate(value, "lastActivityAt") ?? readDate(value, "last_activity_at"),
  };
}

interface HerdrPresentationPayloads {
  workspaces: unknown | null;
  tabs: unknown | null;
  panes: unknown | null;
}

const LOW_INFORMATION_HERDR_LABELS = new Set(["1", "default", "firstmate", "worker"]);

function enrichHerdrPresentation(
  agents: HerdrAgent[],
  payloads: HerdrPresentationPayloads,
): HerdrAgent[] {
  const workspacesById = indexHerdrRecords(payloads.workspaces, "workspaces", "workspace_id");
  const tabsById = indexHerdrRecords(payloads.tabs, "tabs", "tab_id");
  const panesById = indexHerdrRecords(payloads.panes, "panes", "pane_id");

  return agents.map((agent) => {
    const workspace = agent.herdrWorkspaceId
      ? workspacesById.get(agent.herdrWorkspaceId)
      : undefined;
    const tab = agent.tabId ? tabsById.get(agent.tabId) : undefined;
    const pane = agent.paneId ? panesById.get(agent.paneId) : undefined;
    const tokens = workspace ? readRecordField(workspace, "tokens") : null;
    const taskLabel = preferUsefulHerdrLabel(
      agent.taskLabel,
      readFirstString(tokens, ["task", "taskName", "task_name"]),
    );
    const workspaceLabel = preferUsefulHerdrLabel(
      agent.workspaceLabel,
      readFirstString(workspace, ["label", "name"]),
    );
    const reportedTopic = readFirstString(tokens, ["topic", "topicName", "topic_name"]);
    const topic = preferUsefulHerdrLabel(
      agent.topic,
      reportedTopic ?? deriveFirstmateTopicLabel(workspaceLabel),
    );
    const tabLabel = preferUsefulHerdrLabel(
      agent.tabLabel,
      readFirstString(tab, ["label", "name"]),
    );
    const paneLabel = preferUsefulHerdrLabel(
      agent.paneLabel,
      readFirstString(pane, ["label", "name"]),
    );

    return {
      ...agent,
      ...(taskLabel ? { taskLabel } : {}),
      ...(topic ? { topic } : {}),
      ...(workspaceLabel ? { workspaceLabel } : {}),
      ...(tabLabel ? { tabLabel } : {}),
      ...(paneLabel ? { paneLabel } : {}),
    };
  });
}

function preferUsefulHerdrLabel(
  existing: string | undefined,
  enriched: string | null,
): string | undefined {
  if (isUsefulHerdrLabel(existing)) {
    return existing;
  }
  return isUsefulHerdrLabel(enriched) ? enriched : (existing ?? enriched ?? undefined);
}

function isUsefulHerdrLabel(value: string | null | undefined): value is string {
  const normalized = value?.trim();
  return Boolean(
    normalized &&
      !/^FIRSTMATE_OP:\s*v\d+\b/iu.test(normalized) &&
      !LOW_INFORMATION_HERDR_LABELS.has(normalized.toLowerCase()),
  );
}

function deriveFirstmateTopicLabel(workspaceLabel: string | null | undefined): string | null {
  const match = /^firstmate-(.+)$/iu.exec(workspaceLabel ?? "");
  if (!match) {
    return null;
  }
  const topicKey = match[1].replace(/__[0-9a-f]{12}$/iu, "");
  const topic = topicKey.replace(/[-_]+/gu, " ").trim();
  return topic ? `${topic[0].toUpperCase()}${topic.slice(1)}` : null;
}

function indexHerdrRecords(
  payload: unknown,
  collectionKey: string,
  idKey: string,
): Map<string, Record<string, unknown>> {
  const root = unwrapHerdrResult(payload);
  const records = readField(root, collectionKey);
  if (!Array.isArray(records)) {
    return new Map();
  }

  const entries: Array<[string, Record<string, unknown>]> = [];
  for (const record of records) {
    if (!isRecord(record)) {
      continue;
    }
    const id = readString(record, idKey);
    if (id) {
      entries.push([id, record]);
    }
  }
  return new Map(entries);
}

function readHerdrPresentationLabels(
  value: Record<string, unknown>,
): Pick<HerdrAgent, "topic" | "workspaceLabel" | "tabLabel" | "paneLabel"> {
  const workspaceRecord = readRecordField(value, "workspace");
  const tabRecord = readRecordField(value, "tab");
  const paneRecord = readRecordField(value, "pane");
  const topic = readFirstString(value, ["topic", "sessionTopic", "session_topic"]);
  const workspaceLabel = readFirstString(
    value,
    [
      "workspaceLabel",
      "workspace_label",
      "workspaceTitle",
      "workspace_title",
      "workspaceName",
      "workspace_name",
    ],
    workspaceRecord,
    ["label", "name", "title"],
  );
  const tabLabel = readFirstString(
    value,
    ["tabLabel", "tab_label", "tabTitle", "tab_title", "tabName", "tab_name"],
    tabRecord,
    ["label", "name", "title"],
  );
  const paneLabel = readFirstString(
    value,
    [
      "paneLabel",
      "pane_label",
      "paneTitle",
      "pane_title",
      "paneName",
      "pane_name",
      "title",
      "label",
    ],
    paneRecord,
    ["label", "name", "title"],
  );
  return {
    ...(topic ? { topic } : {}),
    ...(workspaceLabel ? { workspaceLabel } : {}),
    ...(tabLabel ? { tabLabel } : {}),
    ...(paneLabel ? { paneLabel } : {}),
  };
}

function unwrapHerdrResult(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }
  return readRecordField(payload, "result") ?? payload;
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readRecordField(value: unknown, key: string): Record<string, unknown> | null {
  const field = readField(value, key);
  return isRecord(field) ? field : null;
}

function readFirstString(
  primary: unknown,
  primaryKeys: readonly string[],
  secondary?: unknown,
  secondaryKeys: readonly string[] = [],
): string | null {
  for (const key of primaryKeys) {
    const value = readString(primary, key);
    if (value) {
      return value;
    }
  }
  for (const key of secondaryKeys) {
    const value = readString(secondary, key);
    if (value) {
      return value;
    }
  }
  return null;
}

function readString(value: unknown, key: string): string | null {
  const field = readField(value, key);
  return typeof field === "string" && field.trim() ? field.trim() : null;
}

function readDate(value: unknown, key: string): Date | null {
  const field = readField(value, key);
  if (typeof field !== "string" && typeof field !== "number") {
    return null;
  }
  const date = new Date(field);
  return Number.isNaN(date.getTime()) ? null : date;
}

function parseWorkspaceIdFromHerdrId(value: string): string | null {
  return value.split(":").find((part) => /^w[0-9A-Za-z]+$/u.test(part)) ?? null;
}

function derivePiSessionIdFromFile(sessionFile: string | null): string | null {
  const filename = sessionFile?.split(/[\\/]/u).at(-1);
  if (!filename) {
    return null;
  }
  const match = /^.+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu.exec(
    filename,
  );
  return match?.[1] ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
