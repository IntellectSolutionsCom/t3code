import { describe, expect, it } from "@effect/vitest";
import { T3F_WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { orUnsupported } from "./linkMessageGrants.ts";

describe("link message grants", () => {
  it.effect("are unsupported on a server that does not know the list", () =>
    Effect.gen(function* () {
      expect(
        yield* orUnsupported(
          Effect.die(`Unknown request tag: ${T3F_WS_METHODS.linkMessageGrantsList}`),
        ),
      ).toEqual({ supported: false });
      expect(yield* orUnsupported(Effect.succeed({ links: [], unconfirmed: [] }))).toEqual({
        supported: true,
        links: [],
        unconfirmed: [],
      });
      const other = yield* orUnsupported(Effect.die("Unknown request tag: other")).pipe(
        Effect.exit,
      );
      expect(other._tag).toBe("Failure");
    }),
  );
});
