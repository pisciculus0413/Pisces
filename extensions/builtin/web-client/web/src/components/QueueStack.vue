<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { type QueueEntry, textOf } from "../protocol.js";

const props = defineProps<{ queue: QueueEntry[] }>();
const emit = defineEmits<{ edit: [id: string, text: string]; remove: [id: string]; clear: [] }>();

const expanded = ref(false);
const editing = ref<string | null>(null);
const draft = ref("");

const entryText = (entry: QueueEntry): string => textOf(entry.content);

function startEdit(entry: QueueEntry): void {
  editing.value = entry.id;
  draft.value = entryText(entry);
}

function commit(entry: QueueEntry): void {
  emit("edit", entry.id, draft.value);
  editing.value = null;
}

/** Alt+↑ expands the stack, matching the TUI habit. */
function onKeydown(event: KeyboardEvent): void {
  if (props.queue.length === 0) return;
  if (event.altKey && event.key === "ArrowUp") {
    event.preventDefault();
    expanded.value = !expanded.value;
  }
}

onMounted(() => window.addEventListener("keydown", onKeydown));
onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));

const summary = computed(() => `↳ ${props.queue.length} 条排队消息 · Alt+↑ 展开`);
</script>

<template>
  <div v-if="queue.length > 0" class="queue-stack">
    <div class="queue-summary" @click="expanded = !expanded">
      <span>{{ summary }}</span>
      <button class="link" type="button" @click.stop="emit('clear')">清空</button>
    </div>
    <div v-if="expanded">
      <div
        v-for="entry in queue"
        :key="entry.id"
        class="queue-entry"
        :class="{ confirmed: entry.confirmedAt !== undefined }"
      >
        <template v-if="editing === entry.id">
          <input v-model="draft" @keydown.enter.prevent="commit(entry)" />
          <button class="link" type="button" @click="commit(entry)">保存</button>
          <button class="link" type="button" @click="editing = null">取消</button>
        </template>
        <template v-else>
          <span class="text">
            {{ entryText(entry) }}
            <span v-if="entry.confirmedAt !== undefined" class="pending">已确认</span>
          </span>
          <button
            v-if="entry.confirmedAt === undefined"
            class="link"
            type="button"
            @click="startEdit(entry)"
          >
            编辑
          </button>
          <button class="link" type="button" @click="emit('remove', entry.id)">删除</button>
        </template>
      </div>
    </div>
  </div>
</template>
