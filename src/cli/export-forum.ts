import { cli } from './runtime.js';
import { exportForumPosts } from '../services/forum-export.js';
await cli('feedback-export', null, async ({ config, store, now }) => exportForumPosts(config, store, now));
