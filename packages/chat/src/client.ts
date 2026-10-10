import type { ChatEvent, MessageCreated, Send } from './event';
import type { GroupId, MessageId } from './id';

export type Append = (event: ChatEvent) => Promise<void>;

export type Client = {
  send(groupId: GroupId, message: Send): Promise<MessageId>;
  message(msgId: MessageId): Promise<MessageCreated | undefined>;
  watch(groupId: GroupId, append: Append): () => void;
  dispose(): void;
};
