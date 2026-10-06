import type { MessageCreated, Send } from './event';
import type { GroupId, MessageId } from './id';

export type Client = {
  send(groupId: GroupId, message: Send): Promise<MessageId>;
  message(msgId: MessageId): Promise<MessageCreated | undefined>;
};
