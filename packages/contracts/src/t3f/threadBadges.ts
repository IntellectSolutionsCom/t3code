import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "../auth.ts";
import { ThreadId } from "../baseSchemas.ts";
import { T3F_WS_METHODS } from "./linkMessageGrants.ts";

const THREAD_BADGE_SYMBOL_MAX_BYTES = 64;
const THREAD_BADGE_LABEL_MAX_CHARACTERS = 24;
const THREAD_BADGE_LABEL_MAX_BYTES = 128;
// Where nothing can count graphemes (Hermes has no `Intl.Segmenter`), a label is bounded by code points instead.
const THREAD_BADGE_LABEL_MAX_CODE_POINTS = 96;

// Wire shapes only bound length; `checkThreadBadge` holds the rest, and only the server runs it.
export const T3fThreadBadge = Schema.Struct({
  symbol: Schema.String.check(Schema.isMaxLength(THREAD_BADGE_SYMBOL_MAX_BYTES)),
  label: Schema.String.check(Schema.isMaxLength(THREAD_BADGE_LABEL_MAX_BYTES)),
});
export type T3fThreadBadge = typeof T3fThreadBadge.Type;

export const T3fThreadBadgeEntry = Schema.Struct({ threadId: ThreadId, ...T3fThreadBadge.fields });
export type T3fThreadBadgeEntry = typeof T3fThreadBadgeEntry.Type;

/** `revision` orders every event of one subscription: a change applies only above the last revision seen. */
export const T3fThreadBadgeEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("snapshot"),
    revision: Schema.Int,
    badges: Schema.Array(T3fThreadBadgeEntry),
  }),
  Schema.Struct({
    type: Schema.Literal("changed"),
    revision: Schema.Int,
    threadId: ThreadId,
    badge: Schema.NullOr(T3fThreadBadge),
  }),
]);
export type T3fThreadBadgeEvent = typeof T3fThreadBadgeEvent.Type;

export const T3fThreadBadgeSetInput = Schema.Struct({
  threadId: ThreadId,
  /** `null` clears the badge. */
  badge: Schema.NullOr(T3fThreadBadge),
});
export type T3fThreadBadgeSetInput = typeof T3fThreadBadgeSetInput.Type;

export class T3fThreadBadgeError extends Schema.TaggedError<T3fThreadBadgeError>()(
  "T3fThreadBadgeError",
  {
    reason: Schema.Literals(["invalid_symbol", "invalid_label", "thread_not_found", "storage"]),
    message: Schema.String,
  },
) {}

export const T3fThreadBadgesSubscribeRpc = Rpc.make(T3F_WS_METHODS.threadBadgesSubscribe, {
  payload: Schema.Struct({}),
  success: T3fThreadBadgeEvent,
  error: Schema.Union([T3fThreadBadgeError, EnvironmentAuthorizationError]),
  stream: true,
});

export const T3fThreadBadgesSetRpc = Rpc.make(T3F_WS_METHODS.threadBadgesSet, {
  payload: T3fThreadBadgeSetInput,
  success: Schema.Struct({ badge: Schema.NullOr(T3fThreadBadge) }),
  error: Schema.Union([T3fThreadBadgeError, EnvironmentAuthorizationError]),
});

const encoder = new TextEncoder();
const byteLength = (value: string) => encoder.encode(value).length;

const special = (codePoint: number) => String.fromCodePoint(codePoint);

// Built on first use: Hermes cannot compile these patterns, and only the server checks a badge.
const compilePatterns = () => {
  const emojiVariation = special(0xfe0f);
  const joiner = special(0x200d);
  const keycap = special(0x20e3);
  const tags = `[${special(0xe0020)}-${special(0xe007e)}]+${special(0xe007f)}`;
  // A skin tone follows only a modifier base: `🚀🏽` is not one symbol.
  const pictogram = `(?:\\p{Emoji_Modifier_Base}\\p{Emoji_Modifier}|\\p{Extended_Pictographic}${emojiVariation}?)`;
  return {
    symbol: new RegExp(
      `^(?:\\p{Regional_Indicator}{2}|[0-9#*]${emojiVariation}?${keycap}|${pictogram}(?:${joiner}${pictogram})*|\\p{Extended_Pictographic}${emojiVariation}?${tags})$`,
      "u",
    ),
    forbidden: new RegExp("[\\p{Cc}\\p{Zl}\\p{Zp}]", "u"),
  };
};
let patterns: ReturnType<typeof compilePatterns> | undefined;
const compiledPatterns = () => (patterns ??= compilePatterns());

export type ThreadBadgeRuleFailure = {
  readonly reason: "invalid_symbol" | "invalid_label";
  readonly message: string;
};

/**
 * The one rule for a badge: one emoji, and a short single-line label. Returns the badge with its label trimmed.
 * `countGraphemes` is the server's `Intl.Segmenter`; without it the symbol and label get only the light checks.
 */
export function checkThreadBadge(
  badge: T3fThreadBadge,
  countGraphemes?: (text: string) => number,
):
  | { readonly ok: true; readonly badge: T3fThreadBadge }
  | ({ readonly ok: false } & ThreadBadgeRuleFailure) {
  const { symbol, forbidden } = compiledPatterns();
  if (
    byteLength(badge.symbol) > THREAD_BADGE_SYMBOL_MAX_BYTES ||
    !symbol.test(badge.symbol) ||
    (countGraphemes !== undefined && countGraphemes(badge.symbol) !== 1)
  ) {
    return { ok: false, reason: "invalid_symbol", message: "The symbol must be a single emoji." };
  }
  const label = badge.label.trim();
  const labelLength = countGraphemes?.(label) ?? Array.from(label).length;
  const labelMax =
    countGraphemes === undefined
      ? THREAD_BADGE_LABEL_MAX_CODE_POINTS
      : THREAD_BADGE_LABEL_MAX_CHARACTERS;
  if (
    labelLength < 1 ||
    labelLength > labelMax ||
    byteLength(label) > THREAD_BADGE_LABEL_MAX_BYTES ||
    forbidden.test(label)
  ) {
    return {
      ok: false,
      reason: "invalid_label",
      message: `The label must be 1 to ${THREAD_BADGE_LABEL_MAX_CHARACTERS} characters on one line.`,
    };
  }
  return { ok: true, badge: { symbol: badge.symbol, label } };
}
