// API client workbench.
//
// A Postman-style pane for composing and sending HTTP requests. It reuses the
// Rust `ai_http_request` command (with private networks allowed) so the user can
// hit local dev servers, and it persists collections/environments so a request
// built once is there next time.

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  ArrowRight02Icon,
  BracesIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Delete01Icon,
  Folder01Icon,
  Globe02Icon,
  PlayIcon,
  Upload01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo, useState } from "react";
import { type SendResponse, sendRequest } from "./bridge";
import { parseCurl } from "./lib/curl";
import { buildHeaders, buildUrl, resolveBody } from "./lib/request";
import { variableMap } from "./lib/variables";
import { useApiClientStore } from "./store";
import {
  type ApiCollection,
  type ApiRequest,
  BODY_MODES,
  type BodyMode,
  emptyCollection,
  emptyEnvironment,
  emptyRequest,
  HTTP_METHODS,
  type HttpMethod,
  makeId,
} from "./types";

type Selection = {
  collectionId: string;
  folderId: string | null;
  requestId: string;
};

/** Render a hugeicon descriptor (an `IconSvgObject`, not a React component). */
function Icon({
  icon,
  className,
  size = 16,
  onClick,
}: {
  icon: unknown;
  className?: string;
  size?: number;
  onClick?: () => void;
}) {
  return (
    <HugeiconsIcon
      icon={icon as never}
      size={size}
      className={className}
      onClick={onClick as never}
    />
  );
}

function statusColor(status: number): string {
  if (status === 0) return "text-red-400";
  if (status < 300) return "text-emerald-400";
  if (status < 400) return "text-amber-400";
  return "text-red-400";
}

/** Pretty-print a body that looks like JSON, else return it unchanged. */
function prettyBody(body: string): string {
  const trimmed = body.trim();
  if (!trimmed) return body;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return body;
    }
  }
  return body;
}

export function ApiClientStack() {
  const store = useApiClientStore();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [response, setResponse] = useState<SendResponse | null>(null);
  const [responseTab, setResponseTab] = useState<"headers" | "body">("body");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [newRequestName, setNewRequestName] = useState("");
  const [envEditorOpen, setEnvEditorOpen] = useState(false);

  const activeCollection = useMemo(
    () =>
      store.collections.find((c) => c.id === store.activeCollectionId) ?? null,
    [store.collections, store.activeCollectionId],
  );
  const activeEnvironment = useMemo(
    () =>
      store.environments.find((e) => e.id === store.activeEnvironmentId) ??
      null,
    [store.environments, store.activeEnvironmentId],
  );

  const activeRequest = useMemo(() => {
    if (!selection || !activeCollection) return null;
    const { folderId, requestId } = selection;
    if (folderId === null) {
      return activeCollection.requests.find((r) => r.id === requestId) ?? null;
    }
    const folder = activeCollection.folders.find((f) => f.id === folderId);
    return folder?.requests.find((r) => r.id === requestId) ?? null;
  }, [selection, activeCollection]);

  const vars = useMemo(
    () => variableMap(activeEnvironment),
    [activeEnvironment],
  );

  const selectRequest = useCallback((sel: Selection) => {
    setSelection(sel);
    setResponse(null);
  }, []);

  const updateRequest = useCallback(
    (patch: Partial<ApiRequest>) => {
      if (!selection || !activeRequest) return;
      store.updateRequest(
        selection.collectionId,
        selection.folderId,
        selection.requestId,
        patch,
      );
    },
    [selection, activeRequest, store],
  );

  const createCollection = useCallback(() => {
    const c = emptyCollection();
    store.addCollection(c);
    setExpanded((s) => new Set(s).add(c.id));
  }, [store]);

  const createRequest = useCallback(
    (folderId: string | null, name: string) => {
      if (!activeCollection) return;
      const req = emptyRequest(name || "New request");
      store.addRequest(activeCollection.id, folderId, req);
      setSelection({
        collectionId: activeCollection.id,
        folderId,
        requestId: req.id,
      });
      setNewRequestName("");
    },
    [activeCollection, store],
  );

  const importCurl = useCallback(() => {
    const text = importText.trim();
    if (!text) return;
    const req = parseCurl(text);
    if (!req) return;
    if (!activeCollection) {
      const c = emptyCollection();
      store.addCollection(c);
      store.addRequest(c.id, null, req);
      setSelection({ collectionId: c.id, folderId: null, requestId: req.id });
    } else {
      store.addRequest(activeCollection.id, null, req);
      setSelection({
        collectionId: activeCollection.id,
        folderId: null,
        requestId: req.id,
      });
    }
    setImportText("");
    setShowImport(false);
  }, [importText, activeCollection, store]);

  const send = useCallback(async () => {
    if (!activeRequest) return;
    const url = buildUrl(activeRequest.url, activeRequest.query, vars);
    const headers = buildHeaders(activeRequest.headers, vars);
    const body = resolveBody(activeRequest, vars);
    setResponse(null);
    const res = await sendRequest({
      url,
      method: activeRequest.method,
      headers,
      body,
    });
    setResponse(res);
    setResponseTab("body");
  }, [activeRequest, vars]);

  const createEnvironment = useCallback(() => {
    const env = emptyEnvironment();
    store.addEnvironment(env);
  }, [store]);

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sidebar: collections + environments */}
      <aside className="flex w-64 shrink-0 flex-col border-r pr-3">
        <div className="flex items-center justify-between px-1 pb-2">
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            API Client
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              title="New collection"
              onClick={createCollection}
            >
              <Icon icon={Add01Icon} className="h-4 w-4" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title="Import cURL"
              onClick={() => setShowImport((v) => !v)}
            >
              <Icon icon={Upload01Icon} className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Environment switcher */}
        <div className="mb-2 flex items-center gap-2 px-1">
          <Select
            value={activeEnvironment?.id ?? ""}
            onValueChange={(v) => store.setActiveEnvironment(v || null)}
          >
            <SelectTrigger size="sm" className="min-w-0 flex-1">
              <SelectValue placeholder="No environment" />
            </SelectTrigger>
            <SelectContent>
              {store.environments.map((env) => (
                <SelectItem key={env.id} value={env.id}>
                  {env.name}
                </SelectItem>
              ))}
              <SelectItem value="__new__">+ New environment</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="icon"
            variant="ghost"
            title="New environment"
            onClick={createEnvironment}
          >
            <Icon icon={Add01Icon} className="h-4 w-4" />
          </Button>
        </div>

        {activeEnvironment && (
          <div className="mb-2 rounded-md border p-2">
            <button
              type="button"
              className="flex w-full items-center justify-between text-xs font-medium"
              onClick={() => setEnvEditorOpen((v) => !v)}
            >
              <span className="truncate">{activeEnvironment.name}</span>
              <Icon
                icon={ChevronDownIcon}
                className={cn(
                  "h-3.5 w-3.5 transition-transform",
                  envEditorOpen ? "" : "-rotate-90",
                )}
              />
            </button>
            {envEditorOpen && (
              <div className="mt-2">
                <KeyValueEditor
                  rows={activeEnvironment.variables}
                  valuePlaceholder="value"
                  onChange={(rows) =>
                    store.updateEnvironment(activeEnvironment.id, {
                      variables: rows.map((r) => ({
                        id: r.id,
                        key: r.key,
                        value: r.value,
                        enabled: r.enabled,
                      })),
                    })
                  }
                />
              </div>
            )}
          </div>
        )}

        {showImport && (
          <div className="mb-2 flex flex-col gap-2 rounded-md border p-2">
            <Textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder={
                'curl -X POST https://api.example.com -H "x-key: 1" -d {"q":1}'
              }
              className="min-h-[64px] text-xs"
            />
            <Button
              size="sm"
              onClick={importCurl}
              disabled={!importText.trim()}
            >
              Import
            </Button>
          </div>
        )}

        <ScrollArea className="flex-1">
          <div className="flex flex-col gap-1 pr-1">
            {store.collections.length === 0 && (
              <p className="px-1 py-3 text-xs text-muted-foreground">
                No collections yet.
              </p>
            )}
            {store.collections.map((c) => {
              const isOpen = expanded.has(c.id);
              return (
                <div key={c.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-1 rounded px-1 py-1 text-left text-sm",
                      activeCollection?.id === c.id
                        ? "bg-accent"
                        : "hover:bg-accent/50",
                    )}
                    onClick={() => {
                      store.setActiveCollection(c.id);
                      setExpanded((s) => {
                        const next = new Set(s);
                        if (next.has(c.id)) next.delete(c.id);
                        else next.add(c.id);
                        return next;
                      });
                    }}
                  >
                    {isOpen ? (
                      <Icon
                        icon={ChevronDownIcon}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                    ) : (
                      <Icon
                        icon={ChevronRightIcon}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                    )}
                    <Icon
                      icon={Folder01Icon}
                      className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                    />
                    <span className="truncate font-medium">{c.name}</span>
                    <Icon
                      icon={Delete01Icon}
                      className="ml-auto h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-red-400"
                      onClick={() => store.removeCollection(c.id)}
                    />
                  </button>

                  {isOpen && activeCollection?.id === c.id && (
                    <div className="ml-3 flex flex-col gap-0.5 border-l pl-2">
                      {/* collection-root requests */}
                      {c.requests.map((r) => (
                        <RequestRow
                          key={r.id}
                          request={r}
                          selected={
                            selection?.requestId === r.id &&
                            selection.folderId === null
                          }
                          onSelect={() =>
                            selectRequest({
                              collectionId: c.id,
                              folderId: null,
                              requestId: r.id,
                            })
                          }
                        />
                      ))}
                      {c.folders.map((f) => (
                        <div key={f.id}>
                          <div className="flex items-center gap-1 py-0.5 text-xs text-muted-foreground">
                            <Icon
                              icon={Folder01Icon}
                              className="h-3 w-3 shrink-0"
                            />
                            <span className="truncate">{f.name}</span>
                            <Icon
                              icon={Delete01Icon}
                              className="ml-auto h-3 w-3 shrink-0 hover:text-red-400"
                              onClick={() => store.removeFolder(c.id, f.id)}
                            />
                          </div>
                          {f.requests.map((r) => (
                            <RequestRow
                              key={r.id}
                              request={r}
                              selected={
                                selection?.requestId === r.id &&
                                selection.folderId === f.id
                              }
                              onSelect={() =>
                                selectRequest({
                                  collectionId: c.id,
                                  folderId: f.id,
                                  requestId: r.id,
                                })
                              }
                            />
                          ))}
                        </div>
                      ))}
                      <div className="flex items-center gap-1 py-0.5">
                        <input
                          value={newRequestName}
                          onChange={(e) => setNewRequestName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              createRequest(null, newRequestName);
                          }}
                          placeholder="New request name"
                          className="min-w-0 flex-1 rounded border bg-background px-1 py-0.5 text-xs"
                        />
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-5 w-5"
                          title="Add request"
                          onClick={() => createRequest(null, newRequestName)}
                        >
                          <Icon icon={Add01Icon} className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </aside>

      {/* Builder + response */}
      <main className="flex min-w-0 flex-1 flex-col gap-3">
        {!activeRequest ? (
          <EmptyState
            activeCollection={activeCollection}
            onCreate={createRequest}
          />
        ) : (
          <>
            {/* Request bar */}
            <div className="flex items-center gap-2">
              <Select
                value={activeRequest.method}
                onValueChange={(v) =>
                  updateRequest({ method: v as HttpMethod })
                }
              >
                <SelectTrigger className="w-28">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {HTTP_METHODS.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={activeRequest.url}
                onChange={(e) => updateRequest({ url: e.target.value })}
                placeholder="https://api.example.com/endpoint"
                className="flex-1 font-mono text-sm"
                spellCheck={false}
              />
              <Button onClick={() => void send()} disabled={!activeRequest.url}>
                <Icon icon={PlayIcon} className="h-4 w-4" /> Send
              </Button>
            </div>

            {/* Build tabs */}
            <Tabs
              defaultValue="params"
              className="flex min-h-0 flex-1 flex-col"
            >
              <TabsList>
                <TabsTrigger value="params">Params</TabsTrigger>
                <TabsTrigger value="headers">Headers</TabsTrigger>
                <TabsTrigger value="body">Body</TabsTrigger>
              </TabsList>

              <TabsContent
                value="params"
                className="min-h-0 flex-1 overflow-auto"
              >
                <KeyValueEditor
                  rows={activeRequest.query}
                  onChange={(rows) => updateRequest({ query: rows })}
                />
              </TabsContent>

              <TabsContent
                value="headers"
                className="min-h-0 flex-1 overflow-auto"
              >
                <KeyValueEditor
                  rows={activeRequest.headers}
                  onChange={(rows) => updateRequest({ headers: rows })}
                  valuePlaceholder="value"
                />
              </TabsContent>

              <TabsContent value="body" className="min-h-0 flex-1">
                <div className="flex h-full flex-col gap-2">
                  <Select
                    value={activeRequest.bodyMode}
                    onValueChange={(v) =>
                      updateRequest({ bodyMode: v as BodyMode })
                    }
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BODY_MODES.map((b) => (
                        <SelectItem key={b.value} value={b.value}>
                          {b.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {activeRequest.bodyMode !== "none" && (
                    <Textarea
                      value={activeRequest.body}
                      onChange={(e) => updateRequest({ body: e.target.value })}
                      placeholder={
                        activeRequest.bodyMode === "json"
                          ? '{\n  "key": "value"\n}'
                          : "raw body"
                      }
                      className="min-h-[160px] flex-1 font-mono text-sm"
                      spellCheck={false}
                    />
                  )}
                </div>
              </TabsContent>
            </Tabs>

            {/* Response */}
            <div className="flex min-h-[200px] flex-col rounded-md border">
              <div className="flex items-center gap-2 border-b px-2 py-1">
                {response ? (
                  <>
                    <span
                      className={cn(
                        "font-mono text-sm font-semibold",
                        statusColor(response.status),
                      )}
                    >
                      {response.status} {response.statusText}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {response.durationMs}ms · {response.sizeBytes}B
                    </span>
                  </>
                ) : (
                  <span className="text-xs text-muted-foreground">
                    No response yet
                  </span>
                )}
              </div>
              {response?.error && (
                <div className="border-b px-2 py-1 text-xs text-red-400">
                  {response.error}
                </div>
              )}
              <Tabs
                value={responseTab}
                onValueChange={(v) => setResponseTab(v as "headers" | "body")}
                className="flex min-h-0 flex-1 flex-col"
              >
                <TabsList>
                  <TabsTrigger value="body">Body</TabsTrigger>
                  <TabsTrigger value="headers">Headers</TabsTrigger>
                </TabsList>
                <TabsContent
                  value="body"
                  className="min-h-0 flex-1 overflow-auto"
                >
                  <pre className="whitespace-pre-wrap p-2 font-mono text-xs">
                    {response ? prettyBody(response.body) : ""}
                  </pre>
                </TabsContent>
                <TabsContent
                  value="headers"
                  className="min-h-0 flex-1 overflow-auto"
                >
                  <div className="p-2 font-mono text-xs">
                    {response &&
                      Object.entries(response.headers).map(([k, v]) => (
                        <div key={k}>
                          <span className="text-muted-foreground">{k}:</span>{" "}
                          {v}
                        </div>
                      ))}
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function EmptyState({
  activeCollection,
  onCreate,
}: {
  activeCollection: ApiCollection | null;
  onCreate: (folderId: string | null, name: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Icon icon={Globe02Icon} className="h-10 w-10 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        Select a request, or create one to start sending HTTP calls.
      </p>
      <Button
        onClick={() => onCreate(null, "New request")}
        disabled={!activeCollection}
      >
        <Icon icon={BracesIcon} className="h-4 w-4" /> New request
      </Button>
      {!activeCollection && (
        <p className="text-xs text-muted-foreground">
          Create a collection first.
        </p>
      )}
    </div>
  );
}

function RequestRow({
  request,
  selected,
  onSelect,
}: {
  request: ApiRequest;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs",
        selected ? "bg-accent font-medium" : "hover:bg-accent/50",
      )}
    >
      <span
        className={cn(
          "w-10 shrink-0 font-mono text-[10px]",
          methodColor(request.method),
        )}
      >
        {request.method}
      </span>
      <span className="truncate">{request.name}</span>
    </button>
  );
}

function methodColor(m: HttpMethod): string {
  switch (m) {
    case "GET":
      return "text-emerald-400";
    case "POST":
      return "text-amber-400";
    case "PUT":
    case "PATCH":
      return "text-sky-400";
    case "DELETE":
      return "text-red-400";
    default:
      return "text-muted-foreground";
  }
}

function KeyValueEditor({
  rows,
  onChange,
  valuePlaceholder = "value",
}: {
  rows: { id: string; key: string; value: string; enabled: boolean }[];
  onChange: (
    rows: { id: string; key: string; value: string; enabled: boolean }[],
  ) => void;
  valuePlaceholder?: string;
}) {
  const update = (
    id: string,
    patch: Partial<{ key: string; value: string; enabled: boolean }>,
  ) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  return (
    <div className="flex flex-col gap-1">
      {rows.map((row) => (
        <div key={row.id} className="flex items-center gap-1">
          <button
            type="button"
            className={cn(
              "h-4 w-4 shrink-0 rounded-sm border text-center text-[10px] leading-3",
              row.enabled
                ? "border-emerald-500 bg-emerald-500/20"
                : "border-muted",
            )}
            onClick={() => update(row.id, { enabled: !row.enabled })}
            title={row.enabled ? "Enabled" : "Disabled"}
          >
            {row.enabled ? "✓" : ""}
          </button>
          <Input
            value={row.key}
            onChange={(e) => update(row.id, { key: e.target.value })}
            placeholder="key"
            className="h-7 w-40 font-mono text-xs"
            spellCheck={false}
          />
          <Input
            value={row.value}
            onChange={(e) => update(row.id, { value: e.target.value })}
            placeholder={valuePlaceholder}
            className="h-7 flex-1 font-mono text-xs"
            spellCheck={false}
          />
          <Button
            size="icon"
            variant="ghost"
            className="h-7 w-7"
            onClick={() => onChange(rows.filter((r) => r.id !== row.id))}
          >
            <Icon icon={Delete01Icon} className="h-3.5 w-3.5" />
          </Button>
        </div>
      ))}
      <Button
        size="sm"
        variant="outline"
        className="mt-1 w-fit"
        onClick={() =>
          onChange([
            ...rows,
            { id: makeId(), key: "", value: "", enabled: true },
          ])
        }
      >
        <Icon icon={ArrowRight02Icon} className="h-3.5 w-3.5" /> Add
      </Button>
    </div>
  );
}
