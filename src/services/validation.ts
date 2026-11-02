import type { Message } from '../schemas/messages.js';
import { tasksSchema, type Task, type Tasks } from '../schemas/tasks.js';
import type { Config } from '../config/index.js';
import type { State } from '../schemas/state.js';

export function validateTasks(input: unknown, messages: Message[], config?: Config): Tasks {
  const data = tasksSchema.parse(input);
  const byId = new Map(messages.map(m => [m.id, m]));
  for (const task of data.tasks) {
    for (const source of task.sources) {
      const message = byId.get(source.messageId);
      if (!message) throw new Error(`Task ${task.id} references unknown Discord message ${source.messageId}`);
      if (config && (message.guildId !== config.discord.guildId || !config.discord.channelIds.includes(message.channelId))) throw new Error(`Task ${task.id} references an out-of-scope message`);
      if (source.nickname !== message.authorDisplayName.trim() || source.channel !== message.channelName.trim() || source.timestamp !== message.timestamp || source.permalink !== message.permalink) throw new Error(`Task ${task.id} source metadata does not match the stored message`);
      // Require a verbatim excerpt; factual paraphrases belong in the description.
      if (!message.content.includes(source.excerpt)) throw new Error(`Task ${task.id} excerpt is not present in the original message`);
    }
  }
  return data;
}
export function pendingState(state: State, tasks: Task[]): void {
  state.sync.awaitingTaskIds = tasks.filter(t => t.syncStatus !== 'synced').map(t => t.id);
  state.sync.synchronizedTaskIds = tasks.filter(t => t.syncStatus === 'synced').map(t => t.id);
}
