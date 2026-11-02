import { cli } from './runtime.js';
import { validateTasks } from '../services/validation.js';
await cli('validate-tasks', null, async ({ store }) => ({ valid: true, tasks: validateTasks(await store.tasks(), (await store.messages()).messages).tasks.length }));
