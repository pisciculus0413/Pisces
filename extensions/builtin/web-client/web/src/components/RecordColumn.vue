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

// The pending branch point (if any) decides which chain stays vertical.
const rail = computed(() => computeRail(props.records, props.branchNodeId ?? undefined));
const maxLane = computed(() => rail.value.reduce((max, cell) => Math.max(max, cell.lane), 0));

/** A system node injected by a source that is no longer selected reads as inactive. */
const isMuted = (node: SessionNode): boolean =>
  node.role === "system" && node.source !== "create" && !props.selection.includes(node.source);

const textOfNode = (node: SessionNode): string => textOf(node.content);
</script>

<template>
  <div class="records">
    <div v-for="(node, index) in records" :key="node.id" class="record-row">
      <RailCell :cell="rail[index]!" :max-lane="maxLane" />
      <ControlChip v-if="!AGENT_ROLES.has(node.role)" :node="node" />
      <MessageNode
        v-else
        :node="node"
        :muted="isMuted(node)"
        :selected="branchNodeId === node.id"
        @branch="emit('branch', $event)"
        @copy="emit('copy', textOfNode(node))"
      />
    </div>
  </div>
</template>
