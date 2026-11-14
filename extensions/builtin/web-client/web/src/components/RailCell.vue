<script setup lang="ts">
import { computed } from "vue";
import type { RailCell } from "../rail.js";

const props = defineProps<{
  cell: RailCell;
  maxLane: number;
  parentLane: number | undefined;
}>();

const LANE_WIDTH = 12;
const STEP = 16;

const width = computed(() => (props.maxLane + 1) * LANE_WIDTH + 6);
const x = (lane: number): number => lane * LANE_WIDTH + 6;
const color = (lane: number): string => `var(--rail-${lane % 4})`;

/** A fork is drawn as an elbow from the parent's lane down into this node's dot. */
const elbow = computed(() => {
  if (!props.cell.branch || props.parentLane === undefined) return undefined;
  const from = x(props.parentLane);
  const to = x(props.cell.lane);
  return `M ${from} 0 C ${from} 10, ${to} 4, ${to} ${STEP}`;
});
</script>

<template>
  <svg :width="width" :height="STEP" aria-hidden="true">
    <line
      v-for="lane in cell.lanes"
      :key="lane"
      :x1="x(lane)"
      :x2="x(lane)"
      y1="0"
      :y2="STEP"
      :stroke="color(lane)"
      :stroke-opacity="lane === cell.lane ? 0.45 : 0.25"
      stroke-width="1.5"
    />
    <path v-if="elbow" :d="elbow" fill="none" :stroke="color(cell.lane)" stroke-width="1.5" />
    <circle :cx="x(cell.lane)" :cy="STEP / 2" r="4" :fill="color(cell.lane)" />
  </svg>
</template>
