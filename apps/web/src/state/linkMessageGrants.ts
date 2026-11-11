import { createLinkMessageGrantAtoms } from "@t3tools/client-runtime/state/linkMessageGrants";

import { connectionAtomRuntime } from "../connection/runtime";

export const linkMessageGrantEnvironment = createLinkMessageGrantAtoms(connectionAtomRuntime);
