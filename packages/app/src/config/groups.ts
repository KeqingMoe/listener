import { GroupId } from '@listener/chat';
import type { GroupFile } from './schema';
import {
  configError,
  fail,
  type Group,
  type GroupConfig,
  type GroupTable,
  type Mentioned,
  merge,
  type PartialDeep,
  topo,
} from './shared';

function mentionedOf(mentioned: boolean | PartialDeep<Mentioned> | undefined) {
  const table =
    mentioned === true
      ? { at: true, reply: true }
      : mentioned === false
        ? { at: false, reply: false }
        : mentioned;
  return table ? { mentioned: table } : {};
}

function normalize(node: GroupFile): {
  derive?: string;
  patch: PartialDeep<Group>;
} {
  if (node === false) {
    return { patch: false };
  }
  const { derive, open, ...rest } = node;
  if (open === undefined) {
    return { derive, patch: rest };
  }
  const { mentioned, ...openRest } = open;
  return {
    derive,
    patch: {
      ...rest,
      open: { ...openRest, ...mentionedOf(mentioned) },
    },
  };
}

const fill: Omit<GroupTable, 'model'> = {
  persona: '',
  open: {
    window: 20,
    poisson: 8,
    mentioned: { at: true, reply: true },
  },
};

function complete(merged: PartialDeep<Group>): Group {
  if (merged === false) {
    return false;
  }
  if (merged.model === undefined) {
    fail(configError.modelRequired);
  }
  return merge(fill, merged);
}

function pickGroups(resolved: Record<string, Group>): GroupConfig {
  const { default: fallback = false, ...rest } = resolved;
  const groups: GroupConfig = { default: fallback };
  for (const [id, node] of Object.entries(rest)) {
    const groupId = GroupId(id);
    if (groupId === undefined || node === fallback) {
      continue;
    }
    groups[groupId] = node;
  }
  return groups;
}

export function resolveGroups(file: Record<string, GroupFile>): GroupConfig {
  const nodes: Record<string, ReturnType<typeof normalize>> = {};
  for (const [id, node] of Object.entries(file)) {
    nodes[id] = normalize(node);
  }

  const resolved: Record<string, Group> = {};
  for (const id of topo(Object.keys(nodes), id => nodes[id]?.derive)) {
    const { derive, patch } = nodes[id]!;
    const parent =
      derive === undefined
        ? undefined
        : (resolved[derive] ?? fail(configError.deriveMissing));
    if (parent === false) {
      fail(configError.deriveNotTable);
    }
    resolved[id] = complete(merge(parent, patch));
  }

  return pickGroups(resolved);
}
