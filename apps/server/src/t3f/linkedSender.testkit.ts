import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerLinks from "../peer/PeerLinks.ts";

/** This environment has no link to anyone. */
export const layerNoLinks = Layer.mock(PeerLinks.PeerLinks)({ get: () => Effect.succeedNone });
