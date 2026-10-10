import type { NCWebsocket } from 'node-napcat-ts';
import type { Append, Client } from './client';
import {
  type GroupId,
  messageId,
  groupId as toGroupId,
  userId as toUserId,
  UnixTime,
} from './id';
import { read, write } from './message';

export function napcat(ws: NCWebsocket): Client {
  const chats = new Map<GroupId, Set<Append>>();

  const unsub = ws.subscribe('message.group', event => {
    const id = toGroupId(event.group_id);
    if (id === undefined) {
      return;
    }
    const group = chats.get(id);
    if (group === undefined) {
      return;
    }
    const stored = read(event);
    if (stored === undefined) {
      return;
    }
    for (const append of group) {
      void append(stored).catch(() => {});
    }
  });

  return {
    watch(groupId, append) {
      let group = chats.get(groupId);
      if (group === undefined) {
        group = new Set();
        chats.set(groupId, group);
      }
      group.add(append);
      return () => {
        const current = chats.get(groupId);
        if (current === undefined) {
          return;
        }
        current.delete(append);
        if (current.size === 0) {
          chats.delete(groupId);
        }
      };
    },

    dispose() {
      unsub();
      chats.clear();
    },

    async send(groupId: GroupId, message) {
      const result = await ws.send('send_group_msg', {
        group_id: Number(groupId),
        message: write(message),
      });
      const id = messageId(result.message_id);
      if (id === undefined) {
        throw new Error('认不出回执');
      }
      return id;
    },

    async message(msgId) {
      const raw = await ws.send('get_msg', { message_id: Number(msgId) });
      const userId = toUserId(raw.user_id);
      const ts = UnixTime(Math.floor(raw.time));
      if (userId === undefined || ts === undefined) {
        return;
      }
      return {
        type: 'message.created',
        msgId,
        ts,
        userId,
        segments: [],
      };
    },
  };
}
