import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const NamedRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  customTitle: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  id: Schema.optional(Schema.String),
  thread_name: Schema.optional(Schema.String),
});
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(NamedRecord));

/** The value of the last record that `pick` reads; `null` from a record clears earlier ones. */
const lastValue = (
  contents: string,
  marker: string,
  pick: (record: typeof NamedRecord.Type) => string | null | undefined,
): string | null => {
  let value: string | null = null;
  for (const line of contents.split("\n")) {
    if (!line.includes(marker)) continue;
    const record = Option.getOrUndefined(decodeRecord(line));
    if (record === undefined) continue;
    const picked = pick(record);
    if (picked !== undefined) value = picked;
  }
  return value;
};

/** Claude writes a `custom-title` record per rename and repeats it; an empty one clears it. */
export const claudeSessionName = (transcript: string): string | null =>
  lastValue(transcript, '"custom-title"', (record) =>
    record.type === "custom-title" && record.customTitle !== undefined
      ? record.customTitle.trim() || null
      : undefined,
  );

/** Codex appends an index entry per rename; like Codex, the newest nonempty name wins. */
export const codexSessionName = (index: string, threadId: string): string | null =>
  lastValue(index, threadId, (record) =>
    record.id === threadId && record.thread_name?.trim() ? record.thread_name.trim() : undefined,
  );

/** Pi names a session by its latest `session_info` on any branch; an empty name clears it. */
export const piSessionName = (session: string): string | null =>
  lastValue(session, '"session_info"', (record) =>
    record.type === "session_info" ? record.name?.trim() || null : undefined,
  );
