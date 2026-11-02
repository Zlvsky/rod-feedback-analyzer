import { args, cli } from './runtime.js';
import { collect } from '../discord/collector.js';
await cli('collect', 'discord', async ({ config, store, discord, now }) => collect(config, store, discord, now, {
  fullHistory: args()['full-history'], feedbackOnly: args()['feedback-only'],
}));
