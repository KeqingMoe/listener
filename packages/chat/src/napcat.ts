import type { NCWebsocket } from 'node-napcat-ts';
import type { Client } from './client';
import { type GroupId, messageId, userId as toUserId, UnixTime } from './id';
import { write } from './message';

export function napcat(ws: NCWebsocket): Client {
  return {
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
