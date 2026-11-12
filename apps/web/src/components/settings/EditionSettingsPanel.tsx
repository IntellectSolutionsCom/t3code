import { useAtomValue } from "@effect/atom-react";
import { Link, useSearch } from "@tanstack/react-router";
import { AuthAccessReadScope, EnvironmentId } from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { CLOSE_BUTTON_TEXT } from "@t3tools/shared/closeButtonText";
import { EDITION_NAME } from "@t3tools/shared/edition";
import { type ReactNode, useEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";
import { authEnvironment } from "~/state/auth";
import { linkMessageGrantEnvironment } from "~/state/linkMessageGrants";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope, useEnvironmentSessionState } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Skeleton } from "../ui/skeleton";
import { Switch } from "../ui/switch";
import {
  type LinkMessageRow,
  linkMessagesState,
  sessionSetKey,
} from "./EditionSettingsPanel.logic";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import { searchableSetting } from "./settingsSearch";
import { useAccessEnvironment } from "./useAccessEnvironment";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** What this edition adds to T3 Code, gathered in one section of its own. */
export function EditionSettingsPanel() {
  // As on Access: a link that names a machine opens the section on it.
  const linkedEnvironmentId = useSearch({
    strict: false,
    select: (search) =>
      typeof search.machine === "string" ? EnvironmentId.make(search.machine) : null,
  });
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState(linkedEnvironmentId);
  const { candidates, environment } = useAccessEnvironment(selectedEnvironmentId);
  return (
    <SettingsPageContainer>
      {environment === null ? null : (
        <LinkMessagesSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
          connected={environment.connection.phase === "connected"}
          environmentPicker={
            candidates.length > 1 ? (
              <Select
                value={environment.environmentId}
                onValueChange={(next) => {
                  if (next !== null) setSelectedEnvironmentId(next);
                }}
              >
                <SelectTrigger size="sm" className="w-auto max-w-56" aria-label="Environment">
                  <SelectValue>
                    {settingsScopeEnvironmentLabel(environment, candidates)}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {candidates.map((candidate) => (
                    <SelectItem
                      hideIndicator
                      key={candidate.environmentId}
                      value={candidate.environmentId}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate">
                          {settingsScopeEnvironmentLabel(candidate, candidates)}
                        </span>
                        {candidate.connection.phase !== "connected" ? (
                          <span className="shrink-0 text-xs text-muted-foreground">Offline</span>
                        ) : null}
                      </span>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null
          }
        />
      )}
      {isElectron && !isMacPlatform(navigator.platform) ? <CloseButtonSettings /> : null}
    </SettingsPageContainer>
  );
}

export function LinkMessagesSettings({
  environmentId,
  connected = true,
  environmentPicker = null,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected?: boolean;
  readonly environmentPicker?: ReactNode;
}) {
  const session = useEnvironmentSessionState(environmentId);
  const hasReadScope = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const readAccess =
    !connected || session.hasError
      ? "unreachable"
      : session.data === null
        ? "unknown"
        : hasReadScope
          ? "granted"
          : "denied";
  const canReadAccess = readAccess === "granted";
  const canSet = useAtomValue(linkMessageGrantEnvironment.set.permissionAtom(environmentId));
  const grants = useEnvironmentQuery(
    canReadAccess ? linkMessageGrantEnvironment.list({ environmentId, input: {} }) : null,
  );
  const access = useEnvironmentQuery(
    canReadAccess ? authEnvironment.accessChanges({ environmentId, input: null }) : null,
  );
  const sessions = access.data?.type === "snapshot" ? access.data.payload.clientSessions : null;
  const sessionKey = sessionSetKey(sessions);
  const refreshGrants = grants.refresh;
  const seenSessionKey = useRef(sessionKey);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the server's grant list changes with its sessions; a link made while this page is open must show without a remount.
  useEffect(() => {
    const previous = seenSessionKey.current;
    seenSessionKey.current = sessionKey;
    if (previous !== null && sessionKey !== previous) refreshGrants();
  }, [sessionKey, refreshGrants]);
  const state = linkMessagesState({
    readAccess,
    grants: { data: grants.data, error: grants.error },
    sessions: { data: sessions, error: access.error },
  });
  const search = searchableSetting("link-messages");

  return (
    <SettingsSection id={search.id} title={search.title} headerAction={environmentPicker}>
      <div className={ITEM_ROW_CLASSNAME}>
        <p className="text-xs text-muted-foreground">
          Lets agents on a machine linked here below full access send messages to any thread here. A
          message can start an idle thread, which then acts with that thread's own permissions.
        </p>
      </div>
      {state.kind === "unreachable" ? (
        <SettingsRow title="This machine cannot be reached right now." />
      ) : state.kind === "no-read-scope" ? (
        <SettingsRow title="This connection cannot view linked machines." />
      ) : state.kind === "unsupported" ? (
        <SettingsRow
          title="This machine cannot allow messages from links."
          description="It runs a version without this setting."
        />
      ) : state.kind === "error" ? (
        <SettingsRow title="Could not load linked machines" description={state.message} />
      ) : state.kind === "loading" ? (
        <div className={ITEM_ROW_CLASSNAME} role="status" aria-label="Loading linked machines">
          <div className="space-y-2">
            <Skeleton shape="pill" className="h-4 w-36" />
            <Skeleton shape="pill" className="h-3 w-full max-w-xs" />
          </div>
        </div>
      ) : (
        <>
          {state.rows.length === 0 ? (
            <SettingsRow
              title="No machine is linked here below full access"
              description="Turn on Linked environments in Settings → Labs on both machines. On the other one, choose Link under Settings → Environments, pick this machine and an access level below full access."
            />
          ) : (
            state.rows.map((row) => (
              <LinkMessageGrantRow
                key={row.sessionId}
                environmentId={environmentId}
                row={row}
                canSet={canSet}
              />
            ))
          )}
          {state.rows.length > 0 && !canSet ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-muted-foreground">
                Changing these needs a connection that may manage clients and operate threads here.
              </p>
            </div>
          ) : null}
          {state.unconfirmed ? (
            <div className={ITEM_ROW_CLASSNAME}>
              <p className="text-xs text-muted-foreground">
                Agents connected before this version can be confirmed by sending one message or
                renewing the link.
              </p>
            </div>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

function LinkMessageGrantRow({
  environmentId,
  row,
  canSet,
}: {
  readonly environmentId: EnvironmentId;
  readonly row: LinkMessageRow;
  readonly canSet: boolean;
}) {
  const setGrant = useAtomCommand(linkMessageGrantEnvironment.set);
  const [saving, setSaving] = useState(false);
  return (
    <div className={ITEM_ROW_CLASSNAME}>
      <div className={ITEM_ROW_INNER_CLASSNAME}>
        <div className="min-w-0 flex-1 space-y-1">
          <h3 className="text-sm font-medium text-foreground">{row.label}</h3>
          <p className="text-xs text-muted-foreground">
            {row.level} · {row.status}
          </p>
        </div>
        <Switch
          checked={row.granted}
          disabled={!canSet || saving}
          aria-label={`Allow ${row.label} to message any thread here`}
          onCheckedChange={(checked) => {
            setSaving(true);
            void setGrant({
              environmentId,
              input: { sessionId: row.sessionId, granted: Boolean(checked) },
            }).finally(() => setSaving(false));
          }}
        />
      </div>
    </div>
  );
}

function CloseButtonSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsSection title="Window">
      <SettingsRow
        {...searchableSetting("close-button")}
        description={CLOSE_BUTTON_TEXT.setting.description}
        resetAction={
          settings.closeButton !== DEFAULT_UNIFIED_SETTINGS.closeButton ? (
            <SettingResetButton
              label="close button behavior"
              onClick={() => updateSettings({ closeButton: DEFAULT_UNIFIED_SETTINGS.closeButton })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.closeButton}
            onValueChange={(value) => {
              if (value === "ask" || value === "quit" || value === "keepRunning") {
                updateSettings({ closeButton: value });
              }
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Close button behavior">
              <SelectValue>{CLOSE_BUTTON_TEXT.setting.options[settings.closeButton]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {Object.entries(CLOSE_BUTTON_TEXT.setting.options).map(([value, label]) => (
                <SelectItem hideIndicator key={value} value={value}>
                  {label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

/** Under Authorized clients: where the message permission for links now lives. */
export function LinkMessagesPointer({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const canReadAccess = useEnvironmentScope(environmentId, AuthAccessReadScope);
  const grants = useEnvironmentQuery(
    canReadAccess ? linkMessageGrantEnvironment.list({ environmentId, input: {} }) : null,
  );
  if (grants.data?.supported !== true) return null;
  return (
    <p className="px-4 py-3 text-xs text-muted-foreground">
      Linked machines below full access can be allowed to send messages to your threads in{" "}
      <Link
        to="/settings/edition"
        search={{ machine: environmentId }}
        className="underline underline-offset-2"
      >
        Settings → {EDITION_NAME}
      </Link>
      .
    </p>
  );
}
