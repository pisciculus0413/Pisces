<script setup lang="ts">
import { computed, ref } from "vue";
import type { EffectiveEntry, EntrySnapshot } from "../protocol.js";

const props = defineProps<{
  entries: EntrySnapshot[];
  selection: string[];
  effective: EffectiveEntry[];
  pending: string[];
}>();
const emit = defineEmits<{ toggle: [name: string] }>();

const KINDS = [
  { key: "tool", label: "工具" },
  { key: "wrapper", label: "包装器" },
  { key: "skill", label: "技能" },
  { key: "context", label: "上下文来源" },
] as const;

const collapsed = ref(false);

const staleNames = computed(
  () => new Set(props.effective.filter((entry) => entry.stale).map((entry) => entry.name)),
);

const groups = computed(() =>
  KINDS.map((kind) => ({
    label: kind.label,
    entries: props.entries.filter((entry) => entry.kind === kind.key),
  })).filter((group) => group.entries.length > 0),
);
</script>

<template>
  <section class="panel" :class="{ collapsed }">
    <button class="link" type="button" @click="collapsed = !collapsed">
      {{ collapsed ? "«" : "»" }}
    </button>
    <template v-if="!collapsed">
      <div>
        <h3>条目</h3>
        <div v-for="group in groups" :key="group.label">
          <div class="group-label">{{ group.label }}</div>
          <label
            v-for="entry in group.entries"
            :key="entry.name"
            class="entry-row"
            :class="{ stale: staleNames.has(entry.name) }"
          >
            <input
              type="checkbox"
              :checked="selection.includes(entry.name)"
              :disabled="staleNames.has(entry.name)"
              @change="emit('toggle', entry.name)"
            />
            <span class="name" :title="entry.description ?? entry.name">{{ entry.name }}</span>
            <span v-if="pending.includes(entry.name)" class="pending">待确认</span>
          </label>
        </div>
        <p v-if="entries.length === 0" class="group-label">没有可用条目</p>
      </div>
    </template>
  </section>
</template>
