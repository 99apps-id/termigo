// Collections and environments for the API client workbench, persisted to
// localStorage so a request you built is still there next time.

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ApiCollection, ApiEnvironment, ApiRequest } from "./types";

type State = {
  collections: ApiCollection[];
  environments: ApiEnvironment[];
  activeCollectionId: string | null;
  activeEnvironmentId: string | null;

  setActiveCollection: (id: string) => void;
  setActiveEnvironment: (id: string | null) => void;

  addCollection: (c: ApiCollection) => void;
  removeCollection: (id: string) => void;
  renameCollection: (id: string, name: string) => void;
  addFolder: (collectionId: string, name: string) => void;
  removeFolder: (collectionId: string, folderId: string) => void;

  addRequest: (
    collectionId: string,
    folderId: string | null,
    req: ApiRequest,
  ) => void;
  removeRequest: (
    collectionId: string,
    folderId: string | null,
    requestId: string,
  ) => void;
  updateRequest: (
    collectionId: string,
    folderId: string | null,
    requestId: string,
    patch: Partial<ApiRequest>,
  ) => void;

  addEnvironment: (env: ApiEnvironment) => void;
  removeEnvironment: (id: string) => void;
  renameEnvironment: (id: string, name: string) => void;
  updateEnvironment: (id: string, patch: Partial<ApiEnvironment>) => void;
};

function mapRequest(
  collection: ApiCollection,
  folderId: string | null,
  requestId: string,
  fn: (r: ApiRequest) => ApiRequest,
): ApiCollection {
  if (folderId === null) {
    return {
      ...collection,
      requests: collection.requests.map((r) =>
        r.id === requestId ? fn(r) : r,
      ),
    };
  }
  return {
    ...collection,
    folders: collection.folders.map((f) =>
      f.id === folderId
        ? {
            ...f,
            requests: f.requests.map((r) => (r.id === requestId ? fn(r) : r)),
          }
        : f,
    ),
  };
}

export const useApiClientStore = create<State>()(
  persist(
    (set) => ({
      collections: [],
      environments: [],
      activeCollectionId: null,
      activeEnvironmentId: null,

      setActiveCollection: (id) => set({ activeCollectionId: id }),
      setActiveEnvironment: (id) => set({ activeEnvironmentId: id }),

      addCollection: (c) =>
        set((s) => ({
          collections: [...s.collections, c],
          activeCollectionId: c.id,
        })),
      removeCollection: (id) =>
        set((s) => ({
          collections: s.collections.filter((c) => c.id !== id),
          activeCollectionId:
            s.activeCollectionId === id ? null : s.activeCollectionId,
        })),
      renameCollection: (id, name) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === id ? { ...c, name } : c,
          ),
        })),

      addFolder: (collectionId, name) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === collectionId
              ? {
                  ...c,
                  folders: [
                    ...c.folders,
                    { id: `${Date.now()}-f`, name, requests: [] },
                  ],
                }
              : c,
          ),
        })),
      removeFolder: (collectionId, folderId) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === collectionId
              ? { ...c, folders: c.folders.filter((f) => f.id !== folderId) }
              : c,
          ),
        })),

      addRequest: (collectionId, folderId, req) =>
        set((s) => ({
          collections: s.collections.map((c) => {
            if (c.id !== collectionId) return c;
            if (folderId === null)
              return { ...c, requests: [...c.requests, req] };
            return {
              ...c,
              folders: c.folders.map((f) =>
                f.id === folderId
                  ? { ...f, requests: [...f.requests, req] }
                  : f,
              ),
            };
          }),
        })),
      removeRequest: (collectionId, folderId, requestId) =>
        set((s) => ({
          collections: s.collections.map((c) => {
            if (c.id !== collectionId) return c;
            if (folderId === null)
              return {
                ...c,
                requests: c.requests.filter((r) => r.id !== requestId),
              };
            return {
              ...c,
              folders: c.folders.map((f) =>
                f.id === folderId
                  ? {
                      ...f,
                      requests: f.requests.filter((r) => r.id !== requestId),
                    }
                  : f,
              ),
            };
          }),
        })),
      updateRequest: (collectionId, folderId, requestId, patch) =>
        set((s) => ({
          collections: s.collections.map((c) =>
            c.id === collectionId
              ? mapRequest(c, folderId, requestId, (r) => ({ ...r, ...patch }))
              : c,
          ),
        })),

      addEnvironment: (env) =>
        set((s) => ({
          environments: [...s.environments, env],
          activeEnvironmentId: env.id,
        })),
      removeEnvironment: (id) =>
        set((s) => ({
          environments: s.environments.filter((e) => e.id !== id),
          activeEnvironmentId:
            s.activeEnvironmentId === id ? null : s.activeEnvironmentId,
        })),
      renameEnvironment: (id, name) =>
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id ? { ...e, name } : e,
          ),
        })),
      updateEnvironment: (id, patch) =>
        set((s) => ({
          environments: s.environments.map((e) =>
            e.id === id ? { ...e, ...patch } : e,
          ),
        })),
    }),
    { name: "termigo-api-client" },
  ),
);
