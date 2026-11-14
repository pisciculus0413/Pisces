<script setup lang="ts">
import { computed } from "vue";
import type { RailCell } from "../rail.js";

const props = defineProps<{ cell: RailCell; maxLane: number }>();

const LANE_WIDTH = 12;
/** Vertical offset of the dot, aligned with the first line of the node header. */
const DOT_Y = 10;

const width = (props.maxLane + 1) * LANE_WIDTH + 6;
const x = (lane: number): number => lane * LANE_WIDTH + 6;
const color = (lane: number): string => `var(--rail-${lane % 4})`;

/** From the parent's lane at the row top, curving into this node's dot. */
const elbow = computed(() => {
  if (!props.cell.branch || props.cell.parentLane === undefined) return undefined;
  const from = x(props.cell.parentLane);
  const to = x(props.cell.lane);
  return `M ${from} 0 C ${from} ${DOT_Y - 4}, ${to} 4, ${to} ${DOT_Y}`;
});

/** The lane this node closes stops at the dot; every other live lane runs through. */
const ownLaneEnd = computed(() => (props.cell.end ? DOT_Y : "100%"));
</script>

<template>
  <svg class="rail" :width="width" aria-hidden="true">
    <line
      v-for="lane in cell.lanes"
      :key="lane"
      :x1="x(lane)"
      :x2="x(lane)"
      y1="0"
      :y2="lane === cell.lane ? ownLaneEnd : '100%'"
      :stroke="color(lane)"
      :stroke-opacity="lane === cell.lane ? 0.5 : 0.32"
      stroke-width="1.5"
    />
    <path v-if="elbow" :d="elbow" fill="none" :stroke="color(cell.lane)" stroke-width="1.5" />
    <circle :cx="x(cell.lane)" :cy="DOT_Y" r="4" :fill="color(cell.lane)" />
  </svg>
</template>
