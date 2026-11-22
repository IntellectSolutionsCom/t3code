import { claudeUserText } from "../project/AgentSessionScanner.ts";

type Comparison =
  | "unknown"
  | "none"
  | {
      readonly count: number | undefined;
      readonly firstId: string;
      readonly shape: "linear" | "split";
    };

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function* records(tail: string) {
  for (const line of tail.split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = object(JSON.parse(line));
      if (record !== undefined) yield record;
    } catch {
      // Some session records cannot be decoded as JSON.
    }
  }
}

export function compareCodex(tail: string, anchor: string, known: ReadonlySet<string>): Comparison {
  let anchored = false;
  const outside = new Set<string>();
  for (const row of records(tail)) {
    const payload = object(row.payload);
    if (row.type === "session_meta" && payload?.history_base != null) return "unknown";
    const id = payload?.turn_id;
    if (
      row.type !== "event_msg" ||
      payload?.type !== "task_started" ||
      typeof id !== "string" ||
      !id.trim()
    )
      continue;
    if (id === anchor) anchored = true;
    else if (anchored && !known.has(id)) outside.add(id);
  }
  const firstId = outside.values().next().value;
  return firstId !== undefined
    ? { count: outside.size, firstId, shape: "linear" }
    : anchored
      ? "none"
      : "unknown";
}

function isOutsidePrompt(row: Record<string, unknown>, sent: ReadonlySet<string>) {
  if (
    row.type !== "user" ||
    row.isMeta === true ||
    row.isSidechain === true ||
    row.isCompactSummary === true
  )
    return false;
  const kind = object(row.origin)?.kind;
  if (kind != null && kind !== "human") return false;
  const content = object(row.message)?.content;
  let text: string;
  // A command run in the terminal, such as /rename, is recorded as a prompt but is not a turn.
  if (typeof content === "string") {
    if (content.startsWith("<command-name>")) return false;
    text = content.trim();
  } else if (Array.isArray(content)) {
    const blocks = content.map(object);
    if (blocks.some((block) => block?.type === "tool_result")) return false;
    text = blocks
      .flatMap((block) =>
        block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
      )
      .join("\n")
      .trim();
  } else return false;
  if (sent.has(text)) return false;
  // A person's prompt may quote Claude Code's markup. Unmarked text is read as the import shows it,
  // so Claude Code's own output is empty and a skill sent from here matches what was sent.
  const shown = kind === "human" ? text : claudeUserText(text).text;
  return shown !== "" && !sent.has(shown);
}

export function compareClaude(tail: string, cursor: string, sent: ReadonlySet<string>): Comparison {
  const linear = new Set<string>();
  const outside = new Set<string>();
  let shape: "linear" | "split" = "linear";
  for (const row of records(tail)) {
    const { uuid, parentUuid } = row;
    if (typeof uuid !== "string" || !uuid) continue;
    if (uuid === cursor && row.type === "assistant" && row.isSidechain !== true) {
      linear.add(cursor);
      continue;
    }
    if (!linear.has(cursor)) continue;
    const descends = typeof parentUuid === "string" && linear.has(parentUuid);
    if (descends) linear.add(uuid);
    if (isOutsidePrompt(row, sent)) {
      outside.add(uuid);
      if (!descends) shape = "split";
    }
  }
  const firstId = outside.values().next().value;
  return firstId !== undefined
    ? { count: outside.size, firstId, shape }
    : linear.has(cursor)
      ? "none"
      : "unknown";
}
