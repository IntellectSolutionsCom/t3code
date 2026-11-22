type Comparison =
  | "unknown"
  | "none"
  | {
      readonly count: number | undefined;
      readonly firstId: string;
      readonly shape: "linear" | "split";
    };

export function completeTail(text: string): string {
  return text.slice(0, text.lastIndexOf("\n") + 1);
}

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

function promptText(row: Record<string, unknown>) {
  if (
    row.type !== "user" ||
    row.isMeta === true ||
    row.isSidechain === true ||
    row.isCompactSummary === true
  )
    return undefined;
  const content = object(row.message)?.content;
  // A command run in the terminal, such as /rename, is recorded as a prompt but is not a turn.
  if (typeof content === "string")
    return content.startsWith("<command-name>") ? undefined : content.trim();
  if (!Array.isArray(content)) return undefined;
  const blocks = content.map(object);
  if (blocks.some((block) => block?.type === "tool_result")) return undefined;
  return blocks
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
    )
    .join("\n")
    .trim();
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
    const text = promptText(row);
    if (text && !sent.has(text)) {
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
