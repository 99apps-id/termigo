// Types for the API client workbench.
//
// A Postman-style workbench: collections hold requests (grouped into folders),
// environments hold variables that are substituted as `{{name}}` in URLs,
// headers and bodies, and the whole model persists so a request you built once
// is there the next time you open the tab.

export type HttpMethod =
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS";

export const HTTP_METHODS: HttpMethod[] = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
];

export type QueryParam = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

export type HeaderEntry = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

export type BodyMode = "none" | "json" | "form" | "raw";

export const BODY_MODES: { value: BodyMode; label: string }[] = [
  { value: "none", label: "none" },
  { value: "json", label: "JSON" },
  { value: "form", label: "x-www-form-urlencoded" },
  { value: "raw", label: "raw" },
];

export type ApiRequest = {
  id: string;
  name: string;
  method: HttpMethod;
  url: string;
  query: QueryParam[];
  headers: HeaderEntry[];
  bodyMode: BodyMode;
  body: string;
};

export type ApiFolder = {
  id: string;
  name: string;
  requests: ApiRequest[];
};

export type ApiCollection = {
  id: string;
  name: string;
  folders: ApiFolder[];
  /** Requests at the collection root, outside any folder. */
  requests: ApiRequest[];
};

export type EnvironmentVariable = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
};

export type ApiEnvironment = {
  id: string;
  name: string;
  variables: EnvironmentVariable[];
};

export type ResponseState = {
  status: number | null;
  statusText: string;
  durationMs: number;
  sizeBytes: number;
  headers: Record<string, string>;
  body: string;
  contentType: string;
  error?: string;
  loading: boolean;
};

export function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function emptyRequest(name = "New request"): ApiRequest {
  return {
    id: makeId(),
    name,
    method: "GET",
    url: "",
    query: [{ id: makeId(), key: "", value: "", enabled: true }],
    headers: [{ id: makeId(), key: "", value: "", enabled: true }],
    bodyMode: "none",
    body: "",
  };
}

export function emptyCollection(name = "My Collection"): ApiCollection {
  return { id: makeId(), name, folders: [], requests: [] };
}

export function emptyEnvironment(name = "New Environment"): ApiEnvironment {
  return { id: makeId(), name, variables: [] };
}
