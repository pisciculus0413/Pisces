<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { ActiveTurn, LiveTurn } from "../store.js";

const props = defineProps<{ live: LiveTurn | null; activeTurn: ActiveTurn | null }>();
const emit = defineEmits<{ cancel: [] }>();

const now = ref(Date.now());
const ticker = setInterval(() => {
  now.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(ticker));

const elapsed = computed(() => {
  if (props.activeTurn === null) return "";
  const startedAt = Date.parse(props.activeTurn.startedAt);
  if (Number.isNaN(startedAt)) return "";
  const seconds = Math.max(0, Math.round((now.value - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
});

const stepLabel = computed(() => {
  const step = props.live?.step ?? 0;
  return step > 0 ? `step ${step}` : "";
});
</script>

<template>
  <div>
    <div class="divider">
      <span>Working</span>
      <span class="meta">{{ stepLabel }}</span>
      <span class="meta">{{ elapsed }}</span>
      <button type="button" :disabled="activeTurn === null" @click="emit('cancel')">Cancel</button>
    </div>
    <div v-if="live && live.reasoning !== ''" class="node system">
      <div class="node-head"><span class="node-role">reasoning</span></div>
      <div class="node-body">{{ live.reasoning }}</div>
    </div>
    <div v-if="live && live.text !== ''" class="node assistant">
      <div class="node-head"><span class="node-role">assistant</span><span class="pending">生成中</span></div>
      <div class="node-body">{{ live.text }}</div>
    </div>
  </div>
</template>
