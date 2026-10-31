import { describeError } from "@corral/client/rpc-errors";
import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  FieldLabel,
  FormError,
  Input,
  RadioGroup,
  RadioGroupItem,
} from "../../common/ui/index.ts";

const RADIO_ROW = "flex cursor-pointer items-center gap-2";

export interface ResolveIssue {
  (
    input: { url: string; provider?: IssueProvider | undefined },
    signal: AbortSignal,
  ): Promise<TaskSource>;
}

interface IssueImportSectionProps {
  /** Called only when the user presses Import, never on paste. */
  onResolveIssue: ResolveIssue;
  source: TaskSource | undefined;
  /** The imported snapshot replaces the draft source. */
  onImported: (source: TaskSource) => void;
  /** The draft no longer matches its source (URL/provider edited, or a new import started). */
  onCleared: () => void;
  /** The issue title is only a default; the dialog decides whether to apply it. */
  onTitleDefault: (title: string) => void;
  onImportingChange: (importing: boolean) => void;
}

export function IssueImportSection({
  onResolveIssue,
  source,
  onImported,
  onCleared,
  onTitleDefault,
  onImportingChange,
}: IssueImportSectionProps) {
  const [issueUrl, setIssueUrl] = useState("");
  const [provider, setProvider] = useState<IssueProvider>();
  const [providerHost, setProviderHost] = useState<string>();
  const [importing, setImporting] = useState(false);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(
    () => () => {
      mounted.current = false;
      const pending = controller.current;
      controller.current = undefined;
      pending?.abort();
    },
    [],
  );

  const clear = () => {
    if (source !== undefined) onCleared();
  };

  const changeUrl = (next: string) => {
    setIssueUrl(next);
    setProviderHost(undefined);
    setProvider(undefined);
    setError(undefined);
    clear();
  };

  const changeProvider = (next: IssueProvider) => {
    setProvider(next);
    setError(undefined);
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = undefined;
    setImporting(false);
    onImportingChange(false);
    setError(undefined);
  };

  const importIssue = async () => {
    const url = issueUrl.trim();
    if (url === "" || importing) return;
    if (providerHost !== undefined && provider === undefined) return;
    clear();
    const current = new AbortController();
    controller.current = current;
    setImporting(true);
    onImportingChange(true);
    setError(undefined);
    try {
      const imported = await onResolveIssue(
        { url, ...(provider === undefined ? {} : { provider }) },
        current.signal,
      );
      if (!mounted.current || current.signal.aborted) return;
      setIssueUrl(imported.url);
      setProviderHost(undefined);
      onImported(imported);
      onTitleDefault(imported.title);
    } catch (reason) {
      if (current.signal.aborted) return;
      const host = providerRequiredHost(reason);
      if (host !== undefined) setProviderHost(host);
      setError(reason);
    } finally {
      if (controller.current === current) {
        controller.current = undefined;
        setImporting(false);
        onImportingChange(false);
      }
    }
  };

  const needsProvider = providerHost !== undefined && provider === undefined;
  const importDisabled = importing || issueUrl.trim() === "" || needsProvider;

  return (
    <fieldset className="mb-2.5 border-0 p-0" aria-busy={importing}>
      <legend className="mb-1 p-0 text-muted-foreground">Import from an issue (optional)</legend>
      <FieldLabel className="mb-2.5 w-full flex-col items-start gap-1 text-muted-foreground">
        Issue URL
        <Input
          value={issueUrl}
          onChange={(event) => changeUrl(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            // Enter in the URL imports; the form Create action would otherwise create a task
            // with no source while the user expected the URL to be read.
            event.preventDefault();
            void importIssue();
          }}
          placeholder="https://github.com/owner/repo/issues/1"
          spellCheck={false}
          autoComplete="off"
        />
      </FieldLabel>
      {providerHost !== undefined && (
        <fieldset className="mb-2.5 border-0 p-0">
          <legend className="mb-1 p-0 text-muted-foreground">
            {providerHost} could be GitHub or GitLab
          </legend>
          <RadioGroup
            className="flex-row gap-3.5"
            value={provider ?? ""}
            onValueChange={(next) => {
              if (next === "github" || next === "gitlab") changeProvider(next);
            }}
          >
            <label className={RADIO_ROW}>
              <RadioGroupItem value="github" />
              GitHub
            </label>
            <label className={RADIO_ROW}>
              <RadioGroupItem value="gitlab" />
              GitLab
            </label>
          </RadioGroup>
        </fieldset>
      )}
      <div className="mb-2.5 flex gap-2">
        <Button variant="outline" onClick={() => void importIssue()} disabled={importDisabled}>
          {importing ? "Importing…" : "Import issue"}
        </Button>
        {importing && (
          <Button variant="outline" onClick={cancel}>
            Cancel import
          </Button>
        )}
      </div>
      {source !== undefined && !importing && (
        <p className="mb-2.5 text-muted-foreground" role="status">
          Imported {providerName(source.provider)} issue {source.repository}#{source.number}. Its
          original title and text will be kept with the task.
        </p>
      )}
      {error !== undefined && !importing && <FormError>{describeError(error)}</FormError>}
    </fieldset>
  );
}

function providerName(provider: IssueProvider): string {
  return provider === "github" ? "GitHub" : "GitLab";
}

/** `ISSUE_PROVIDER_REQUIRED` from the contract, without pulling ORPCError into the browser bundle. */
function providerRequiredHost(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  if (Reflect.get(error, "code") !== "ISSUE_PROVIDER_REQUIRED") return undefined;
  const data = Reflect.get(error, "data");
  if (typeof data !== "object" || data === null) return undefined;
  const host = Reflect.get(data, "host");
  return typeof host === "string" ? host : undefined;
}
