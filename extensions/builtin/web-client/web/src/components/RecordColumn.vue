<script setup lang="ts">
import { computed } from "vue";
import { type SessionNode, textOf } from "../protocol.js";
import { computeRail } from "../rail.js";
import ControlChip from "./ControlChip.vue";
import MessageNode from "./MessageNode.vue";
import RailCell from "./RailCell.vue";

const props = defineProps<{
  records: SessionNode[];
  selection: string[];
  branchNodeId: string | null;
}>();
const emit = defineEmits<{ branch: [nodeId: string]; copy: [text: string] }>();

const AGENT_ROLES = new Set(["system", "user", "assistant", "tool"]);

const rail = computed(() => computeRail(props.records));
const laneOf = computed(() => new Map(rail.value.map((cell) => [cell.id, cell.lane])));
const maxLane = computed(() => rail.value.reduce((max, cell) => Math.max(max, cell.lane), 0));

const isMuted = (node: SessionNode): boolean =>
  node.role === "system" &&
  props.selection.includes(node.source) === false &&
  node.source !== "create";

const parentLaneOf = (node: SessionNode): number | undefined => {
  if (!rail.value.some((cell) => cell.branch && cell.id === node.id)) return undefined;
  return laneOf.value.get(node.parentId);
};
</script>

<template>
  <div class="records">
    <div v-for="(node, index) in records" :key="node.id" class="record-row">
      <RailCell :cell="rail[index]!" :max-lane="maxLane" :parent-lane="parentLaneOf(node)" />
      <ControlChip v-if="!AGENT_ROLES.has(node.role)" :node="node" />
      <MessageNode
        v-else
        :node="node"
        :muted="isMuted(node)"
        :selected="branchNodeId === node.id"
        @branch="emit('branch', $event)"
        @copy="emit('copy', $event)"
      />
    </div>
  </div>
</template>
