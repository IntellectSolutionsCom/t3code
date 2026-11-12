import { createFileRoute } from "@tanstack/react-router";
import { EditionSettingsPanel } from "../components/settings/EditionSettingsPanel";

export const Route = createFileRoute("/_chat/settings/edition")({
  component: EditionSettingsPanel,
});
