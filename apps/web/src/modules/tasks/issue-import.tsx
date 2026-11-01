import { describeError } from "@corral/client/rpc-errors";
import type { IssueProvider, TaskSource } from "@corral/protocol/rpc";
import { useEffect, useRef, useState } from "react";
import {
  Button,
  FormField,
  FormError,
  Input,
  RadioGroup,
  RadioChoice,
  FieldSet,
  FieldLegend,
} from "../../common/ui/index.ts";

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
  onImportingChange: (importing: boolean) => void;
}

export function IssueImportSection({
  onResolveIssue,
  source,
  onImported,
  onCleared,
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
    <FieldSet aria-busy={importing}>
      <FieldLegend>Import from an issue (optional)</FieldLegend>
      <FormField label="Issue URL">
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
      </FormField>
      {providerHost !== undefined && (
        <FieldSet>
          <FieldLegend>{providerHost} could be GitHub or GitLab</FieldLegend>
          <RadioGroup
            value={provider ?? ""}
            onValueChange={(next) => {
              if (next === "github" || next === "gitlab") changeProvider(next);
            }}
          >
            <RadioChoice value="github">GitHub</RadioChoice>
            <RadioChoice value="gitlab">GitLab</RadioChoice>
          </RadioGroup>
        </FieldSet>
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
    </FieldSet>
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
