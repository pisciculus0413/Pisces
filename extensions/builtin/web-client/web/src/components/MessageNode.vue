<script setup lang="ts">
import { computed } from "vue";
import { type SessionNode, textOf } from "../protocol.js";

const props = defineProps<{ node: SessionNode; selected: boolean; muted: boolean }>();
const emit = defineEmits<{ branch: [nodeId: string]; copy: [text: string] }>();

const text = computed(() => textOf(props.node.content));
const label = computed(() => (props.node.role === "tool" ? "tool result" : props.node.role));
const time = computed(() => new Date(props.node.createdAt).toLocaleTimeString());
</script>

<template>
  <div class="node" :class="[node.role, { muted: muted }]">
    <div class="node-head">
      <span class="node-role">{{ label }}</span>
      <span>{{ node.source }}</span>
      <span>{{ time }}</span>
      <span v-if="node.synthetic === 'interrupted'" class="pending">崩溃中断</span>
      <span v-if="selected" class="pending">当前分支点</span>
    </div>
    <div class="node-body">{{ text }}</div>
    <div class="node-actions">
      <button class="link" type="button" @click="emit('copy', text)">复制</button>
      <button class="link" type="button" @click="emit('branch', node.id)">以此为分支起点</button>
    </div>
  </div>
</template>
