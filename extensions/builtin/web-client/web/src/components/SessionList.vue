<script setup lang="ts">
import { computed } from "vue";
import type { SessionMeta } from "../protocol.js";

const props = defineProps<{
  sessions: SessionMeta[];
  activeSessionIds: string[];
  currentId: string | null;
}>();
const emit = defineEmits<{ select: [id: string]; create: [] }>();

const BUCKETS = ["今天", "昨天", "7 天内", "更早"] as const;

function bucketOf(createdAt: string): (typeof BUCKETS)[number] {
  const created = Date.parse(createdAt);
  if (Number.isNaN(created)) return "更早";
  const days = (Date.now() - created) / 86_400_000;
  if (days < 1) return "今天";
  if (days < 2) return "昨天";
  if (days < 7) return "7 天内";
  return "更早";
}

const groups = computed(() => {
  const sorted = [...props.sessions].sort((left, right) =>
    left.createdAt < right.createdAt ? 1 : left.createdAt > right.createdAt ? -1 : 0,
  );
  return BUCKETS.map((label) => ({
    label,
    sessions: sorted.filter((session) => bucketOf(session.createdAt) === label),
  })).filter((group) => group.sessions.length > 0);
});

const title = (session: SessionMeta): string => `${session.provider}/${session.model}`;
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar-head">
      <button class="primary" type="button" style="width: 100%" @click="emit('create')">
        + 新建会话
      </button>
    </div>
    <div class="sidebar-list">
      <template v-for="group in groups" :key="group.label">
        <div class="group-label">{{ group.label }}</div>
        <button
          v-for="session in group.sessions"
          :key="session.id"
          class="session-row"
          :class="{ current: session.id === currentId }"
          type="button"
          @click="emit('select', session.id)"
        >
          <span class="title">{{ title(session) }}</span>
          <span v-if="activeSessionIds.includes(session.id)" class="dot" title="有活跃 turn" />
        </button>
      </template>
      <p v-if="sessions.length === 0" class="group-label">还没有已落盘的会话</p>
    </div>
  </aside>
</template>
