<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { ApiError, apiGet, apiSend, openEventStream } from "./api.js";
import ActiveTurn from "./components/ActiveTurn.vue";
import EntriesPanel from "./components/EntriesPanel.vue";
import MessageComposer from "./components/MessageComposer.vue";
import ModelPanel from "./components/ModelPanel.vue";
import QueueStack from "./components/QueueStack.vue";
import RecordColumn from "./components/RecordColumn.vue";
import SessionList from "./components/SessionList.vue";
import type {
  ActiveTurn as ActiveTurnRecord,
  ModelInfo,
  ProviderInfo,
  QueueEntry,
  SessionMeta,
} from "./protocol.js";
import {
  applyActiveTurns,
  applyEntries,
  applyEvent,
  applyRead,
  emptySession,
  type SessionState,
} from "./store.js";

const sessions = ref<SessionMeta[]>([]);
const providers = ref<ProviderInfo[]>([]);
const activeTurns = ref<ActiveTurnRecord[]>([]);
const state = ref<SessionState>({ ...emptySession });
const branchNodeId = ref<string | null>(null);
const error = ref<string | null>(null);
const busy = ref(false);
const creating = ref(false);
const workspace = ref("");
const newProvider = ref("");
const newModel = ref("");
const composer = ref<InstanceType<typeof MessageComposer> | null>(null);

let stopEvents: (() => void) | undefined;

const currentId = computed(() => state.value.meta?.id ?? null);
const steering = computed(() => state.value.activeTurn !== null);

const pendingNames = computed(() => {
  const names: string[] = [];
  for (const entry of state.value.queue) {
    if (entry.role !== "declaration") continue;
    for (const block of entry.content) {
      if (block.type !== "text") continue;
      try {
        const parsed = JSON.parse(block.text) as { toggle?: unknown };
        if (Array.isArray(parsed.toggle)) {
          for (const name of parsed.toggle) if (typeof name === "string") names.push(name);
        }
      } catch {
        // A malformed toggle is the daemon's problem, not the panel's.
      }
    }
  }
  return names;
});

const newProviderModels = computed(
  () => providers.value.find((item) => item.id === newProvider.value)?.models ?? [],
);

function report(cause: unknown): void {
  if (cause instanceof ApiError) {
    error.value = `${cause.code}: ${cause.message}`;
    return;
  }
  error.value = "请求失败";
}

async function refreshLists(): Promise<void> {
  const [list, turns, catalog] = await Promise.all([
    apiGet<{ sessions: SessionMeta[] }>("/api/sessions"),
    apiGet<{ turns: ActiveTurnRecord[] }>("/api/turns"),
    apiGet<{ providers: ProviderInfo[] }>("/api/providers"),
  ]);
  sessions.value = list.sessions;
  activeTurns.value = turns.turns;
  providers.value = catalog.providers;
  if (newProvider.value === "" && catalog.providers.length > 0) {
    const ready = catalog.providers.find((item) => item.ready && item.models.length > 0);
    const first = ready ?? catalog.providers[0];
    if (first !== undefined) {
      newProvider.value = first.id;
      newModel.value = first.models[0]?.id ?? "";
    }
  }
}

async function readSession(sessionId: string): Promise<void> {
  const [read, entries] = await Promise.all([
    apiGet<{
      meta: SessionMeta;
      seq: number;
      records: SessionState["records"];
      queue: QueueEntry[];
      selection: string[];
    }>(`/api/sessions/${encodeURIComponent(sessionId)}`),
    apiGet<{
      entries: SessionState["entries"];
      selection: string[];
      effective: SessionState["effective"];
    }>(`/api/sessions/${encodeURIComponent(sessionId)}/entries`),
  ]);
  // A fresh read establishes the seq watermark; later events must be newer.
  state.value = applyEntries(applyRead(emptySession, read), entries);
  // `turn.list` is re-read here: attaching mid-turn must restore the live block,
  // and a turn that ended while disconnected must not leave a phantom active turn.
  activeTurns.value = await apiGet<{ turns: ActiveTurnRecord[] }>("/api/turns").then(
    (result) => result.turns,
  );
  state.value = applyActiveTurns(state.value, activeTurns.value);
  const active = state.value.activeTurn;
  state.value =
    active === null
      ? state.value
      : { ...state.value, live: { turnId: active.turnId, step: 0, text: "", reasoning: "" } };
}

async function select(sessionId: string): Promise<void> {
  error.value = null;
  branchNodeId.value = null;
  stopEvents?.();
  try {
    await readSession(sessionId);
    stopEvents = openEventStream(sessionId, {
      onEvent(frame) {
        state.value = applyEvent(state.value, frame);
      },
      onReconnect() {
        void readSession(sessionId).catch(report);
      },
    });
  } catch (cause) {
    report(cause);
  }
}

async function startTurn(): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  await apiSend("POST", `/api/sessions/${encodeURIComponent(sessionId)}/turns`, {
    // A steer must not carry a branch point: the daemon rejects that combination
    // after the message is already queued.
    ...(steering.value || branchNodeId.value === null ? {} : { nodeId: branchNodeId.value }),
  });
  branchNodeId.value = null;
  activeTurns.value = await apiGet<{ turns: ActiveTurnRecord[] }>("/api/turns").then(
    (result) => result.turns,
  );
  state.value = applyActiveTurns(state.value, activeTurns.value);
}

async function send(text: string): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  error.value = null;
  busy.value = true;
  try {
    await apiSend("POST", `/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
      entries: [{ kind: "agent", role: "user", source: "web", content: [{ type: "text", text }] }],
    });
    await startTurn();
    composer.value?.clear();
  } catch (cause) {
    report(cause);
  } finally {
    busy.value = false;
  }
}

async function cancel(): Promise<void> {
  const turn = state.value.activeTurn;
  if (turn === null) return;
  error.value = null;
  try {
    await apiSend("POST", `/api/turns/${encodeURIComponent(turn.turnId)}/cancel`, {});
  } catch (cause) {
    report(cause);
  }
}

async function createSession(): Promise<void> {
  error.value = null;
  try {
    const meta = await apiSend<SessionMeta>("POST", "/api/sessions", {
      workspace: workspace.value.trim(),
      provider: newProvider.value,
      model: newModel.value,
    });
    creating.value = false;
    await refreshLists();
    await select(meta.id);
    composer.value?.focus();
  } catch (cause) {
    report(cause);
  }
}

async function toggleEntry(name: string): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  try {
    await apiSend("POST", `/api/sessions/${encodeURIComponent(sessionId)}/queue`, {
      entries: [
        {
          kind: "control",
          role: "declaration",
          source: "web",
          content: [{ type: "text", text: JSON.stringify({ toggle: [name] }) }],
        },
      ],
    });
  } catch (cause) {
    report(cause);
  }
}

async function editQueue(id: string, text: string): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  try {
    await apiSend(
      "PATCH",
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`,
      { content: [{ type: "text", text }] },
    );
  } catch (cause) {
    report(cause);
  }
}

async function removeQueue(id: string): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  try {
    await apiSend(
      "DELETE",
      `/api/sessions/${encodeURIComponent(sessionId)}/queue/${encodeURIComponent(id)}`,
    );
  } catch (cause) {
    report(cause);
  }
}

async function clearQueue(): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  try {
    await apiSend("DELETE", `/api/sessions/${encodeURIComponent(sessionId)}/queue`);
  } catch (cause) {
    report(cause);
  }
}

async function configure(provider: string, model: string): Promise<void> {
  const sessionId = currentId.value;
  if (sessionId === null) return;
  try {
    const meta = await apiSend<SessionMeta>(
      "PATCH",
      `/api/sessions/${encodeURIComponent(sessionId)}`,
      { provider, model },
    );
    state.value = { ...state.value, meta };
  } catch (cause) {
    report(cause);
  }
}

async function copy(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    error.value = "浏览器拒绝了剪贴板访问";
  }
}

function pickBranch(nodeId: string): void {
  branchNodeId.value = nodeId;
}

const modelLabel = (model: ModelInfo): string => model.id;

onMounted(async () => {
  try {
    await refreshLists();
    const newest = sessions.value[0];
    if (newest !== undefined) await select(newest.id);
    else creating.value = true;
  } catch (cause) {
    report(cause);
  }
});

onBeforeUnmount(() => stopEvents?.());
</script>

<template>
  <div class="layout">
    <SessionList
      :sessions="sessions"
      :active-session-ids="activeTurns.map((turn) => turn.sessionId)"
      :current-id="currentId"
      @select="select"
      @create="creating = true"
    />
    <main class="center">
      <div v-if="error !== null" class="error-bar">{{ error }}</div>
      <div v-if="currentId === null" class="empty-state">
        <template v-if="creating">
          <div class="new-session-form">
            <strong>新建会话</strong>
            <label class="row">
              <span style="width: 72px; color: var(--muted)">工作区</span>
              <input v-model="workspace" placeholder="绝对路径；留空使用默认工作区" style="flex: 1" />
            </label>
            <label class="row">
              <span style="width: 72px; color: var(--muted)">provider</span>
              <select v-model="newProvider" style="flex: 1" @change="newModel = newProviderModels[0]?.id ?? ''">
                <option v-for="item in providers" :key="item.id" :value="item.id">
                  {{ item.id }}{{ item.ready ? "" : "（未就绪）" }}
                </option>
              </select>
            </label>
            <label class="row">
              <span style="width: 72px; color: var(--muted)">model</span>
              <select v-model="newModel" style="flex: 1">
                <option v-for="model in newProviderModels" :key="model.id" :value="model.id">
                  {{ modelLabel(model) }}
                </option>
              </select>
            </label>
            <button class="primary" type="button" @click="createSession">创建</button>
          </div>
        </template>
        <template v-else>
          <span>选择一个会话，或新建一个</span>
        </template>
      </div>
      <template v-else>
        <RecordColumn
          :records="state.records"
          :selection="state.selection"
          :branch-node-id="branchNodeId"
          @branch="pickBranch"
          @copy="copy"
        />
        <div
          v-if="state.activeTurn !== null || state.live !== null"
          class="records"
          style="flex: 0; padding-bottom: 0"
        >
          <ActiveTurn :live="state.live" :active-turn="state.activeTurn" @cancel="cancel" />
        </div>
        <div class="composer-area">
          <QueueStack
            :queue="state.queue"
            @edit="editQueue"
            @remove="removeQueue"
            @clear="clearQueue"
          />
          <MessageComposer ref="composer" :steering="steering" :busy="busy" @send="send" />
        </div>
      </template>
    </main>
    <template v-if="currentId !== null">
      <EntriesPanel
        :entries="state.entries"
        :selection="state.selection"
        :effective="state.effective"
        :pending="pendingNames"
        @toggle="toggleEntry"
      />
      <ModelPanel
        :providers="providers"
        :meta="state.meta"
        :busy="steering"
        @configure="configure"
      />
    </template>
  </div>
</template>
