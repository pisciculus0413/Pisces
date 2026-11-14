<script setup lang="ts">
import { computed, ref } from "vue";
import { type SessionNode, textOf } from "../protocol.js";

const props = defineProps<{ node: SessionNode }>();
const expanded = ref(false);

const label = computed(() => {
  switch (props.node.role) {
    case "declaration":
      return "声明变更";
    case "compaction":
      return "压缩记录";
    case "cancel":
      return "已中止";
    default:
      return props.node.role;
  }
});

const summary = computed(() => {
  const text = textOf(props.node.content);
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
});
</script>

<template>
  <div>
    <button class="chip" type="button" @click="expanded = !expanded">
      <span>{{ label }}</span>
      <span v-if="!expanded">{{ summary }}</span>
    </button>
    <div v-if="expanded" class="chip-body">{{ textOf(node.content) || "（无内容）" }}</div>
  </div>
</template>
