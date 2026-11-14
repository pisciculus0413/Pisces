/**
 * Rail geometry for the record column.
 *
 * Rows are the append order of the session tree (oldest first). The branch that
 * ends at the active tip owns lane 0 and stays vertical for its whole length;
 * every other branch hangs off to the side, opening a lane at the row where it
 * forks and closing it at its own last node. The tree only appends and each node
 * has one parent, so lanes never merge.
 */

export const RAIL_COLORS = 4;

export interface RailCell {
  id: string;
  /** Lane index of this node, 0 is the active chain. */
  lane: number;
  /** True when the parent sits on another lane (this row opens the side lane). */
  branch: boolean;
  /** Lanes to draw as vertical lines on this row, ascending. */
  lanes: number[];
  color: number;
  /** Lane of the parent, when the fork elbow must start there. */
  parentLane: number | undefined;
  /** True when no later row continues this node's lane (draw up to the dot only). */
  end: boolean;
}

export interface RailInput {
  id: string;
  parentId: string;
}

export function computeRail(nodes: readonly RailInput[], activeId?: string): RailCell[] {
  if (nodes.length === 0) return [];

  const parentOf = new Map<string, string>();
  for (const node of nodes) parentOf.set(node.id, node.parentId);

  // The active chain is the ancestor path of the tip; everything else is a branch.
  const activePath = new Set<string>();
  let cursor = activeId ?? nodes[nodes.length - 1]?.id;
  while (cursor !== undefined && !activePath.has(cursor)) {
    activePath.add(cursor);
    const parent = parentOf.get(cursor);
    cursor = parent === cursor ? undefined : parent;
  }
  if (activePath.size === 0) return [];

  const laneOf = new Map<string, number>();
  const firstRowOfLane = new Map<number, number>();
  const lastRowOfLane = new Map<number, number>();
  let nextLane = 1;

  nodes.forEach((node, row) => {
    let lane: number;
    if (activePath.has(node.id)) {
      lane = 0;
    } else {
      const parentLane = laneOf.get(node.parentId);
      // Continue the parent's side lane; fork onto a fresh lane from lane 0.
      lane = parentLane !== undefined && parentLane > 0 ? parentLane : nextLane++;
    }
    const parentLane = node.parentId === node.id ? undefined : laneOf.get(node.parentId);
    // The parent's lane has to stay drawn down to the fork row, otherwise the
    // elbow that opens this branch starts in mid-air.
    if (parentLane !== undefined) lastRowOfLane.set(parentLane, row);
    laneOf.set(node.id, lane);
    if (!firstRowOfLane.has(lane)) firstRowOfLane.set(lane, row);
    lastRowOfLane.set(lane, row);
  });

  return nodes.map((node, row) => {
    const lane = laneOf.get(node.id) ?? 0;
    const parentLane = node.parentId === node.id ? 0 : laneOf.get(node.parentId);
    const lanes: number[] = [];
    for (const [candidate, first] of firstRowOfLane) {
      const last = lastRowOfLane.get(candidate) ?? first;
      if (row >= first && row <= last) lanes.push(candidate);
    }
    lanes.sort((left, right) => left - right);
    return {
      id: node.id,
      lane,
      branch: parentLane !== undefined && parentLane !== lane,
      lanes,
      color: lane % RAIL_COLORS,
      parentLane,
      end: lastRowOfLane.get(lane) === row,
    };
  });
}
