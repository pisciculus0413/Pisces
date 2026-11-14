/**
 * Rail geometry for the record column.
 *
 * The session tree only ever appends and every node has exactly one parent, so
 * lanes never merge: a fork opens the next free lane to the right and stays
 * there while its branch continues. The record column renders one row per node
 * and needs to know, for that row, which lanes are live.
 */

export const RAIL_COLORS = 4;

export interface RailCell {
  id: string;
  /** Lane index of this node, 0 is left-most. */
  lane: number;
  /** True when the parent is not the previous row (the node starts a branch). */
  branch: boolean;
  /** Lanes that are live on this row, ascending, always including `lane`. */
  lanes: number[];
  color: number;
}

export interface RailInput {
  id: string;
  parentId: string;
}

export function computeRail(nodes: readonly RailInput[]): RailCell[] {
  const laneOf = new Map<string, number>();
  // Index = lane, value = id of the node currently occupying that lane.
  const active: string[] = [];
  const cells: RailCell[] = [];
  let previous: string | undefined;

  for (const node of nodes) {
    let lane: number;
    if (node.parentId === node.id) {
      lane = 0;
    } else {
      const parentLane = laneOf.get(node.parentId);
      // Reuse the parent's lane only while the parent is still that lane's tip;
      // forking from an older node opens a new lane instead of overwriting.
      lane =
        parentLane !== undefined && active[parentLane] === node.parentId
          ? parentLane
          : firstFree(active);
    }
    laneOf.set(node.id, lane);
    active[lane] = node.id;

    const lanes: number[] = [];
    for (let index = 0; index < active.length; index += 1) {
      if (active[index] !== undefined) lanes.push(index);
    }

    cells.push({
      id: node.id,
      lane,
      branch: previous !== undefined && node.parentId !== previous,
      lanes,
      color: lane % RAIL_COLORS,
    });
    previous = node.id;
  }

  return cells;
}

function firstFree(active: readonly string[]): number {
  for (let index = 0; index < active.length; index += 1) {
    if (active[index] === undefined) return index;
  }
  return active.length;
}
