# rod-discord-feedback

A local feedback pipeline for **Realm of Dungeons**:

1. TypeScript collects Discord messages and refreshes board-wide Trello context.
2. **Codex itself** analyzes local feedback and produces structured tasks.
3. TypeScript validates tasks and creates Trello cards or appends new evidence.

No backend, hosted infrastructure, separate AI API, model SDK, or keyword classifier. Messages, tasks, checkpoints, reports, and mock state are local JSON. Trello receives task summaries and selected player evidence. Codex necessarily reads player text during reasoning; use an appropriate account/workspace for that data.

## Install and verify

Requirements: **Node.js 22+**, npm, Git, Codex with local project access. Real integration additionally needs a Discord bot and Trello key/user token. Tests need no credentials.

```sh
npm ci
npm run typecheck
npm test
npm run build
npm run demo
```

Git is already initialized. Commit `package-lock.json`; never commit `.env` or runtime data. Copy `.env.example` to `.env` only if `.env` does not already exist. Preserve an existing `.env` and edit it locally.

## Environment configuration

Fill these eight values in `.env`; never paste credentials into chat:

| Variable | Value |
| --- | --- |
| `DISCORD_BOT_TOKEN` | Bot token |
| `DISCORD_GUILD_ID` | Server snowflake ID |
| `DISCORD_FEEDBACK_CHANNEL_ID` | Feedback channel snowflake ID |
| `DISCORD_GENERAL_EN_CHANNEL_ID` | General English channel snowflake ID |
| `TRELLO_API_KEY` | Trello Power-Up API key |
| `TRELLO_TOKEN` | Authorized Trello user token |
| `TRELLO_BOARD_ID` | Full 24-character board ID |
| `TRELLO_LIST_ID` | Full 24-character destination list ID |

Other settings have defaults:

| Setting | Default | Purpose |
| --- | --- | --- |
| `DRY_RUN` | `true` | Only explicit `false` enables real Trello writes |
| `DATA_DIR` | `./data` | Persistent local storage; absolute path recommended for scheduling |
| `INITIAL_LOOKBACK_DAYS` | `7` | First collection window |
| `COLLECTION_OVERLAP_MINUTES` | `60` | History overlap around the last collected snowflake |
| `CONTEXT_MESSAGES` | `3` | Nearby human messages on each side, maximum 20 |
| `HTTP_MAX_RETRIES` | `4` | Extra attempts for safe reads/rejected writes |
| `HTTP_TIMEOUT_MS` | `20000` | Per-request timeout |
| `MOCK_MODE` | `false` | Explicit offline fixtures and isolated storage |

`TRELLO_KEY` is accepted as an alias when `TRELLO_API_KEY` is missing or empty. `TRELLO_SECRET` is not needed for API key/token authentication.

Booleans must be `true` or `false`; misspellings fail validation. Shell environment values take precedence over `.env`. `npm run check:config` validates locally without network requests. State binds to its guild/channels and board/list; use a separate DATA_DIR for a different integration.

## Discord credentials and permissions

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and open **Bot** settings. Generate/reset the token and save it locally as `DISCORD_BOT_TOKEN`.
2. Enable **Message Content Intent**. Without it Discord may omit text and attachments. Larger verified applications may need approval. This project uses REST, no Gateway or member-roster access. See the [official message resource](https://docs.discord.com/developers/resources/message).
3. Use the installation/OAuth2 URL generator with the **bot** scope. Grant only **View Channel** and **Read Message History** (permission integer `66560`). Do not grant Administrator or message-writing permissions.
4. Install in your server; restrict the role/channel overwrites to the two intended channels. The collector additionally enforces exact configured channel and guild IDs. It does not traverse threads, forums, other channels, or DMs.
5. Enable Discord **Developer Mode**. Right-click the server and both channels, copy their IDs, and fill `.env`.
6. Run `npm run collect` and inspect `data/messages.json` locally. An unexpected empty channel can mean missing Read Message History permission; Discord can return an empty array in that case.

Names prefer a supplied server nickname, then global display name, then username. REST responses do not always include server nicknames; the available fallback is preserved without collecting the guild roster. Attachments are metadata only and are never downloaded.

Collection checks the bot application's Message Content Intent flags before scanning channels. If the intent is disabled, collection stops without advancing checkpoints. Analysis also refuses a dataset containing only empty message bodies. After restoring access, collection backfills any unprocessed empty records left by an older collector, even outside the usual overlap; existing original quotes and analyzed evidence stay intact.

## Trello credentials, board and list IDs

1. In [Trello Power-Up administration](https://trello.com/apps/admin), create/select a Power-Up, open **Trello Auth**, and generate an API key.
2. Follow its token authorization link and grant `read,write` access for an account with access to the board. Save the token as `TRELLO_TOKEN`; renew it when it expires. A separate automation account can restrict exposed boards. Follow the [official authorization guide](https://developer.atlassian.com/cloud/trello/guides/rest-api/authorization/).
3. Open an existing card in the destination list (or create one manually) and append `.json` to its URL in your signed-in browser. Copy `idBoard` and `idList` from the JSON. Alternatively use board **Export JSON** and inspect `id` and `lists`. Use full IDs, not URL short links.
4. Optionally create board labels named `bug`, `balancing`, `feature`, `improvement`, `minor`, and `major`. Matching trims whitespace and ignores case. Existing labels are applied to new cards; labels on existing cards are preserved.
5. Keep `DRY_RUN=true`, then run `npm run trello:context`. It verifies the board and destination list and considers cards in every list, including archived cards.

Only the [official Trello REST API](https://developer.atlassian.com/cloud/trello/rest/) is used, with your configured key/token.

## Commands

| Command | Behavior |
| --- | --- |
| `npm run init:data` | Initialize local JSON, preserving valid existing data |
| `npm run check:config` | Validate environment locally; no API calls |
| `npm run collect` | Read the two Discord channels |
| `npm run trello:context` | Refresh the entire board snapshot and comment source references |
| `npm run analysis:prepare` | Save the analysis queue and input digest |
| `npm run analysis:accept` | Validate Codex's draft, merge tasks, acknowledge reviewed messages |
| `npm run tasks:validate` | Validate tasks and exact source provenance |
| `npm run sync:trello` | Refresh board state; create cards or append new evidence |
| `npm run summary` | Save a daily summary and outstanding work |
| `npm run workflow:begin` | Acquire a lease spanning all Codex stages |
| `npm run workflow:end -- --run-id UUID` | Release your workflow lease |
| `npm run sync:resolve -- --operation HASH --not-applied` | Human-confirmed release of an uncertain operation for retry |
| `npm run typecheck` / `npm test` / `npm run build` | Strict typechecking, tests, compiled JS |
| `npm run demo` | Full offline integration using static expected analysis |
| `npm run demo:prepare -- --mock` | Prepare synthetic messages for Codex's actual reasoning |

Common flags: `--mock`, `--data-dir PATH`, `--run-id UUID`, passed after npm's `--`. Synchronization accepts `--dry-run`, overriding `DRY_RUN=false`. `--mock --simulate-writes` enables **local simulated writes only**; it cannot access the network. Mock mode otherwise defaults to dry-run, ignores real credentials and `.env` DATA_DIR, and uses `data/mock` unless `--data-dir` is supplied.

Exit codes: **0** completed, **1** failure, **2** sync completed with review items. Exit 2 can accompany successful writes for other tasks; report the partial result without a tight retry loop.

## Run the whole workflow manually in Codex

Open this checkout in Codex and ask:

> Follow AGENTS.md and prompts/daily-automation.md to run the three-stage feedback workflow once. Perform semantic analysis yourself with prompts/analyze-feedback.md. Respect DRY_RUN and do not schedule anything.

Codex first runs these commands, using the UUID returned by workflow:begin:

```sh
npm run check:config
npm run workflow:begin
npm run collect -- --run-id UUID
npm run trello:context -- --run-id UUID
npm run analysis:prepare -- --run-id UUID
```

Codex reads `data/analysis-input.json`, `messages.json`, `state.json`, `tasks.json`, and `trello-context.json`. It follows [the analysis prompt](prompts/analyze-feedback.md) and writes its actual reasoning output to **data/analysis.json**: tasks, input digest, analyzed IDs, ignored IDs/reasons. This step is performed by Codex, not an npm classifier or external model.

```sh
npm run analysis:accept -- --run-id UUID
npm run tasks:validate -- --run-id UUID
npm run sync:trello -- --run-id UUID
npm run summary -- --run-id UUID
npm run workflow:end -- --run-id UUID
```

Acceptance atomically merges the structured output into **data/tasks.json**, then commits analysis dispositions. The extra draft/accept boundary prevents loss of existing unsynchronized tasks and rejects invented sources. Omitted existing tasks/sources are preserved. Stale input requires refreshed preparation and rebased analysis. Small batches are allowed; unreviewed IDs remain pending. On an empty queue, skip analysis:accept and still sync pending tasks. Release the lease in a finally step after failures.

Type (`bug`, `balancing`, `feature`, `improvement`) and impact (`minor`, `major`) are independent. Confidence is 0–1. Clarification flags, confidence below 0.7, and uncertain card matches require review. The automation does not send clarification questions to players.

## Dry-run and testing each stage

With real credentials and `DRY_RUN=true`, the workflow collects Discord messages and reads Trello but prohibits all Trello POST requests. Force a preview with:

```sh
npm run sync:trello -- --dry-run
```

Planned operations are printed and saved to `data/sync-results.json`. Sync checkpoints and mappings do not advance. Do not confuse planned operations with completed cards.

For a completely offline pipeline:

```sh
npm run demo
```

Every demo creates a fresh `data/demo-UUID` directory. It uses hand-authored expected analysis, then exercises collection, context, validation, dry-run, local simulated writes, a Trello 429/retry, and an idempotent rerun. Expected: **13 human messages, 9 stored tasks, 6 new simulated cards, 2 evidence comments, 1 review task, no duplicate writes on rerun**. The vague dungeon report intentionally remains for clarification.

To test Codex's actual reasoning with synthetic conversations:

```sh
npm run workflow:begin -- --mock
npm run demo:prepare -- --mock --run-id UUID
```

Ask Codex to analyze `data/mock` with the analysis prompt and write its own `data/mock/analysis.json`, then run:

```sh
npm run analysis:accept -- --mock --run-id UUID
npm run tasks:validate -- --mock --run-id UUID
npm run sync:trello -- --mock --dry-run --run-id UUID
npm run sync:trello -- --mock --simulate-writes --run-id UUID
npm run summary -- --mock --run-id UUID
npm run workflow:end -- --mock --run-id UUID
```

Automated tests cover bugs, balance, features, UI polish, multiple reporters, two suggestions in one message, casual chat, prior-day repetition, existing-card matches, malformed AI output, retries, pagination, provenance forgery, expired tokens, locks, scopes, dry-run, and ambiguous-write recovery. Tests require no real credentials.

## Local files and checkpoints

### Legacy feedback to forum JSON

Use an isolated data directory for a historical migration so daily analysis and
Trello checkpoints stay separate. Acquire a workflow lease as usual, then collect
with `--full-history --feedback-only` to read all accessible messages from the
configured legacy feedback text channel. These flags do not enable forum
traversal or Discord writes. Continue with Trello context and analysis preparation.

Codex must review the complete conversations and write the standard analysis
draft. Group repeated discussion by underlying issue, retain developer responses
that clarify its outcome, and use short plain-text titles and descriptions.
Include resolved feedback when requested. After accepting and validating analysis:

```sh
npm run feedback:export -- --data-dir data/YOUR-MIGRATION --run-id UUID --dry-run
```

This writes `feedback-posts.json` with `posts` and `reviewItems`. Each post contains
a title, condensed description, `content` ending with `-- submitted by @username`,
the original submitter ID, and exact source message IDs and URLs. The first
chronological evidence author receives the footer credit. Titles are limited to
100 characters and full content to 2000. Clarification or low-confidence items
remain in the review list with their source links. This command is local only;
it neither publishes forum posts nor synchronizes Trello. Finish with summary
and release the workflow lease. Force `--dry-run` for any migration Trello preview.

| File under DATA_DIR | Contents |
| --- | --- |
| `messages.json` | Versioned original messages, replies, nearby context IDs, attachment metadata |
| `tasks.json` | All valid tasks and supporting sources |
| `trello-context.json` | Current board-wide context and Discord/task references |
| `state.json` | Separate collection/analysis/sync checkpoints, mappings, operation intents, successful-stage timestamps, retry errors |
| `analysis-input.json` | Pending analysis IDs and snapshot digest |
| `analysis.json` | Codex-written draft |
| `sync-results.json` | Preserved run history, planned writes, durable intents, outcomes, reviews |
| `daily-summary.json` | Latest summary |
| `.execution.lock`, `workflow-lock.json` | Command mutex and cross-stage lease |
| `mock-server.json` | Simulated API state in mock directories only |

Messages are written before collection cursors advance. Tasks are written before analysis dispositions advance. Sync success is based on remote evidence and durable mappings, never an AI-authored status alone. Original captured content is immutable; overlap enriches context without replacing earlier quotes with subsequently edited text. This is a new-message pipeline, not an edit/delete audit. Attachment-only details remain unexamined.

The collector walks backwards with snowflake pagination to the seven-day cutoff or previous cursor minus overlap. This avoids skipping a busy channel by advancing directly to the largest ID in a limited page. It retains bounded nearby context and explicitly referenced human replies from allowed channels. Bots/webhooks are ignored; their IDs may still advance collection cursors. Explicit reply references can precede the window.

Duplicate prevention combines exact IDs, task-scoped source markers, persistent task/card and message/card maps, board-wide descriptions/comments, and Codex semantic reasoning. Message-to-card maps are one-to-many because one message can contain unrelated suggestions. Markers are `[rod-task:rod-...]`, `[rod-source:rod-...:MESSAGE_ID]`, and `[rod-op:HASH]`. Preserve these markers.

Existing cards receive only clearly marked comments containing new evidence. Their titles, descriptions, lists, archive state, and labels are preserved. Archived, missing, off-board, conflicting, or uncertain matches require review. Weak text similarity never triggers a merge.

Safe reads retry network errors and 5xx responses; all requests honor 429 retry hints and rate headers. Trello writes retry only explicit rejections such as 429. Network interruptions, 5xx, or invalid successful-write responses have ambiguous outcomes; saved operation intents are held until recovered by markers. See [Discord rate limits](https://docs.discord.com/developers/topics/rate-limits) and [Trello rate limits](https://developer.atlassian.com/cloud/trello/guides/rest-api/rate-limits/).

## Recovery

- **Interrupted stage:** rerun that stage or the workflow. Pending tasks survive. If tasks were saved but analysis state was not, prepare again and rebase; stable IDs/sources prevent loss.
- **Card created but local save failed:** sync finds its remote marker and rebuilds the mapping instead of creating a duplicate. Evidence comments are recovered similarly.
- **Uncertain write without visible marker:** wait for visibility, then rerun sync. If a human verifies in Trello that the write was definitely not applied, run `npm run sync:resolve -- --operation HASH --not-applied` with writes enabled, then sync. The command rechecks markers before releasing the operation. Never automate that confirmation.
- **Malformed JSON:** execution stops without resetting the file. Restore a private backup, validate, and rerun. Back up the whole DATA_DIR together, especially messages/tasks/state.
- **401/403 or expired token:** renew credentials/fix permissions locally and rerun. Logs omit credentials and API response bodies.
- **Stale lock:** inspect PID/host/time in `.execution.lock` or the workflow lease. Confirm the prior process/Codex run has stopped. Release your own workflow with its run ID. Remove `.execution.lock` manually only after its owner has stopped; age alone is insufficient.
- **Review task:** inspect evidence/current context and use a new Codex analysis draft with the same task ID to clarify details or confirm a match. Never suppress flags merely to pass sync.

Trello history uses creation-ID pagination per [official paging guidance](https://developer.atlassian.com/cloud/trello/guides/rest-api/api-introduction/#paging). An unordered full page or non-advancing cursor stops execution instead of accepting an incomplete snapshot. Large boards exhibiting that API behavior require a pagination adjustment before syncing. Board-wide comment reads favor correctness over speed. Trello provides no atomic conditional board-membership write; immediate rechecks reduce but cannot eliminate races with simultaneous external moves. Run one installation per integration: local locks cannot coordinate independent machines.

## Schedule later

**No automation is created or enabled by installation.** Complete a real dry-run and review the proposed cards. When ready, set `DRY_RUN=false` locally and run the workflow once for real writes.

Later, open the desktop app's **Scheduled/Automations** area, create a daily local-project task for this checkout, and paste all of [prompts/daily-automation.md](prompts/daily-automation.md). Choose your time and timezone, e.g. Europe/Warsaw. Use **local project** execution so ignored data and `.env` persist; isolated worktrees require explicit shared storage/configuration. Keep the computer on and app running for local files, and permit the API requests under your sandbox settings. Test the saved prompt manually before enabling it. See [official scheduled-task documentation](https://learn.chatgpt.com/docs/automations?surface=app).

## Security

- No hardcoded credentials. Mock tokens/players are explicitly fictitious.
- `.env`, runtime `data/`, dependencies, build output, and logs are gitignored. A custom DATA_DIR inside another Git location needs its own ignore rule.
- Fixed HTTPS origins: `discord.com` and `api.trello.com`; redirects are refused. Player URLs are never fetched.
- No Discord mutation methods or Trello delete/move/archive/description-update methods.
- Zod validates API responses and strict local/task schemas. Source IDs, metadata, and exact original excerpts are checked. Generated text rejects unsafe controls and reserved markers; rendered evidence escapes Markdown and mentions.
- Files are created with `0600`, directories with `0700`; sensitive local reads refuse symlinks. Existing directory permissions are not automatically changed.
- Keep real player data out of fixtures/Git, apply your community's privacy practices, and keep only needed evidence. Never modify game repositories in this pipeline.
