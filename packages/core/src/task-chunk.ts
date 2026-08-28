export const MAX_SLACK_TASK_CHUNK_LENGTH = 256;

export const SLACK_TASK_FALLBACK_TITLE = "Step";

type SlackTaskStatus = "pending" | "in_progress" | "complete" | "error";

export interface SlackTaskUpdate {
  id: string;
  title: string;
  status: SlackTaskStatus;
  output?: string;
}

// Slack's `task_update` chunk, not the `task_card` block: the chunk keys the
// task on `id` and takes `details`/`output` as plain strings, where the block
// uses `task_id` and rich_text entities.
// `id` is passed through unredacted because Slack never renders it: it is
// only a correlation key, so the rendering-side attacks the sanitizer exists
// to stop (broadcast pings, `<@...>` control sequences, markdown injection)
// are unreachable through that field. An empty runtime id is stored as `_`
// so the chunk stays a valid key. The budget path may still truncate the
// id, and that is accepted. `title` and `output` are the visible text.
export interface SlackTaskChunk {
  type: "task_update";
  id: string;
  title: string;
  status: SlackTaskStatus;
  output?: string;
}

// Slack budgets 256 characters per `task_update` chunk without splitting that
// across its fields, and an oversized chunk comes back `invalid_chunks` - a
// rejected append that would cost the user the whole reply. So the serialized
// chunk is what gets measured, and the budget is spent in priority order: the
// output first, then the title down to its fallback, and only then the id,
// which is opaque. `title` is required, so it never empties.
const taskChunkEncoder = new TextEncoder();

// Measured in UTF-8 bytes, which is at least the character count Slack
// documents: overshooting costs a shorter preview, undershooting costs the
// reply. A UTF-16 length would undercount every non-ASCII result.
const oversizeOf = (chunk: SlackTaskChunk): number =>
  taskChunkEncoder.encode(JSON.stringify(chunk)).length -
  MAX_SLACK_TASK_CHUNK_LENGTH;

// The overflow is a byte count but a slice is indexed in UTF-16 units, so the
// cut is scaled by the text's own bytes-per-unit rather than subtracted raw,
// which would erase a multibyte field wholesale on the first pass.
const trimTaskField = (text: string, overflow: number): string => {
  const bytes = taskChunkEncoder.encode(text).length;
  const drop =
    bytes === 0 ? text.length : Math.ceil((overflow * text.length) / bytes);
  const kept = text.slice(0, Math.max(0, text.length - drop));
  // A slice can land between the halves of a surrogate pair, and the orphan
  // would reach Slack escaped as a replacement character.
  const whole = /[\uD800-\uDBFF]$/u.test(kept) ? kept.slice(0, -1) : kept;
  return whole.trimEnd();
};

const shrinkTaskChunk = (
  chunk: SlackTaskChunk,
  overflow: number,
): SlackTaskChunk | undefined => {
  const { id, output, title, ...rest } = chunk;
  if (output !== undefined) {
    const kept = trimTaskField(output, overflow);
    return kept === ""
      ? { ...rest, id, title }
      : { ...rest, id, output: kept, title };
  }
  if (title !== SLACK_TASK_FALLBACK_TITLE) {
    const kept = trimTaskField(title, overflow);
    return {
      ...rest,
      id,
      title: kept === "" ? SLACK_TASK_FALLBACK_TITLE : kept,
    };
  }
  if (id.length > 1) {
    return {
      ...rest,
      id: id.slice(0, Math.max(1, id.length - overflow)),
      title,
    };
  }
  return undefined;
};

export const clampTaskChunk = (chunk: SlackTaskChunk): SlackTaskChunk => {
  let fitted = chunk;
  let overflow = oversizeOf(fitted);
  while (overflow > 0) {
    const next = shrinkTaskChunk(fitted, overflow) ?? fitted;
    // Identity is the no-progress case: shrink returned undefined, so
    // `?? fitted` reused the current chunk and further passes cannot help.
    if (next === fitted) {
      return next;
    }
    fitted = next;
    overflow = oversizeOf(next);
  }
  return fitted;
};
