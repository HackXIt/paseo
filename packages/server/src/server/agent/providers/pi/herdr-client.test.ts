import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import {
  HerdrCliClient,
  parseHerdrAgentListPayload,
  parseHerdrAgentPayload,
} from "./herdr-client.js";

describe("Herdr client parsing", () => {
  test("parses wrapped Herdr agent list output", () => {
    expect(
      parseHerdrAgentListPayload({
        id: "cli:agent:list",
        result: {
          type: "agent_list",
          agents: [
            {
              id: "pane-1",
              name: "firstmate",
              kind: "pi",
              status: "idle",
              cwd: "/workspace/project",
              pane_id: "%7",
              agent_session: {
                id: "native-pi-session",
                file: "/tmp/pi/native.jsonl",
              },
            },
          ],
        },
      }),
    ).toEqual([
      {
        target: "firstmate",
        id: "pane-1",
        name: "firstmate",
        kind: "pi",
        status: "idle",
        cwd: "/workspace/project",
        paneId: "%7",
        nativeSessionId: "native-pi-session",
        nativeSessionFile: "/tmp/pi/native.jsonl",
        lastActivityAt: null,
      },
    ]);
  });

  test("parses wrapped Herdr agent get output", () => {
    expect(
      parseHerdrAgentPayload({
        id: "cli:agent:get",
        result: {
          type: "agent",
          agent: {
            target: "%9",
            agent_kind: "pi",
            lifecycle: "working",
            working_directory: "/workspace/project",
            session_file: "/tmp/pi/native.jsonl",
            session_id: "native-pi-session",
          },
        },
      }),
    ).toMatchObject({
      target: "%9",
      kind: "pi",
      status: "working",
      cwd: "/workspace/project",
      nativeSessionId: "native-pi-session",
      nativeSessionFile: "/tmp/pi/native.jsonl",
    });
  });

  test("parses real path-shaped Herdr Pi list records", () => {
    expect(
      parseHerdrAgentListPayload({
        id: "cli:agent:list",
        result: {
          agents: [
            {
              agent: "pi",
              agent_session: {
                agent: "pi",
                kind: "path",
                source: "herdr:pi",
                value:
                  "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
              },
              agent_status: "working",
              cwd: "/workspace/registered-project",
              foreground_cwd: "/workspace/project",
              pane_id: "w1Q:p2",
            },
          ],
          type: "agent_list",
        },
      }),
    ).toEqual([
      {
        target: "w1Q:p2",
        kind: "pi",
        status: "working",
        cwd: "/workspace/project",
        paneId: "w1Q:p2",
        nativeSessionId: "01a04974-6e86-7db6-a718-ffd7c4f0af2d",
        nativeSessionFile:
          "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
        lastActivityAt: null,
      },
    ]);
  });

  test("parses Herdr relation and own-status fields", () => {
    expect(
      parseHerdrAgentPayload({
        result: {
          agent: {
            status: "working",
            agent_status: "idle",
            workspace_id: "w2D",
            parent_pane_id: "w2D:pA",
            agent: "pi",
            pane_id: "w2D:pC",
            foreground_cwd: "/workspace/worker",
            agent_session: {
              value:
                "/home/example/.pi/agent/sessions/--workspace-worker--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
            },
          },
        },
      }),
    ).toMatchObject({
      target: "w2D:pC",
      kind: "pi",
      status: "working",
      ownStatus: "idle",
      herdrWorkspaceId: "w2D",
      parentTarget: "w2D:pA",
    });
  });

  test("parses Herdr presentation labels for import display", () => {
    expect(
      parseHerdrAgentPayload({
        result: {
          agent: {
            agent: "pi",
            pane_id: "w9:p2",
            foreground_cwd: "/workspace/worker",
            topic: "finances",
            workspace_label: "firstmate-finances",
            tab_label: "fm-review-copy",
            pane_title: "Review copy worker",
            agent_session: {
              value:
                "/home/example/.pi/agent/sessions/--workspace-worker--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
            },
          },
        },
      }),
    ).toMatchObject({
      target: "w9:p2",
      topic: "finances",
      workspaceLabel: "firstmate-finances",
      tabLabel: "fm-review-copy",
      paneLabel: "Review copy worker",
    });
  });

  test("enriches agent rows from Herdr workspace, tab, and pane metadata", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-herdr-cli-"));
    const script = path.join(root, "herdr-fixture.mjs");
    await writeFile(
      script,
      `
const operation = process.argv.slice(2, 4).join(" ");
const payloads = {
  "agent list": { result: { agents: [{
    agent: "pi",
    agent_status: "idle",
    foreground_cwd: "/workspace/project",
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    workspace_id: "w1",
    agent_session: { id: "native-pi-session", value: "/tmp/pi/native.jsonl" }
  }, {
    agent: "pi",
    agent_status: "idle",
    foreground_cwd: "/workspace/firstmate",
    pane_id: "w2:p1",
    tab_id: "w2:t1",
    workspace_id: "w2",
    agent_session: { id: "firstmate-native-session", value: "/tmp/pi/firstmate.jsonl" }
  }] } },
  "workspace list": { result: { workspaces: [{
    workspace_id: "w1",
    label: "firstmate-herdr-import-ux-polish",
    tokens: { task: "Polish import labels", topic: "Herdr import UX polish" }
  }, {
    workspace_id: "w2",
    label: "firstmate-review-import-ui__3eaec6ea7e22"
  }] } },
  "tab list": { result: { tabs: [{
    tab_id: "w1:t1",
    workspace_id: "w1",
    label: "fm-mobile-fallback"
  }, {
    tab_id: "w2:t1",
    workspace_id: "w2",
    label: "firstmate"
  }] } },
  "pane list": { result: { panes: [{
    pane_id: "w1:p1",
    tab_id: "w1:t1",
    workspace_id: "w1",
    label: "Mobile fallback worker"
  }, {
    pane_id: "w2:p1",
    tab_id: "w2:t1",
    workspace_id: "w2",
    label: "firstmate"
  }] } }
};
process.stdout.write(JSON.stringify(payloads[operation]));
`,
      "utf8",
    );

    try {
      const client = new HerdrCliClient({ command: [process.execPath, script] });

      await expect(client.listAgents()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            target: "w1:p1",
            taskLabel: "Polish import labels",
            topic: "Herdr import UX polish",
            workspaceLabel: "firstmate-herdr-import-ux-polish",
            tabLabel: "fm-mobile-fallback",
            paneLabel: "Mobile fallback worker",
          }),
          expect.objectContaining({
            target: "w2:p1",
            topic: "Review import ui",
            workspaceLabel: "firstmate-review-import-ui__3eaec6ea7e22",
            tabLabel: "firstmate",
            paneLabel: "firstmate",
          }),
        ]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("parses real path-shaped Herdr Pi get records", () => {
    expect(
      parseHerdrAgentPayload({
        id: "cli:agent:get",
        result: {
          agent: {
            agent: "pi",
            agent_session: {
              agent: "pi",
              kind: "path",
              source: "herdr:pi",
              value:
                "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
            },
            agent_status: "idle",
            cwd: "/workspace/registered-project",
            foreground_cwd: "/workspace/project",
            pane_id: "w1Q:p2",
          },
          type: "agent_info",
        },
      }),
    ).toMatchObject({
      target: "w1Q:p2",
      kind: "pi",
      status: "idle",
      cwd: "/workspace/project",
      paneId: "w1Q:p2",
      nativeSessionId: "01a04974-6e86-7db6-a718-ffd7c4f0af2d",
      nativeSessionFile:
        "/home/example/.pi/agent/sessions/--workspace-project--/2026-08-28T17-39-22-374Z_01a04974-6e86-7db6-a718-ffd7c4f0af2d.jsonl",
    });
  });
});
