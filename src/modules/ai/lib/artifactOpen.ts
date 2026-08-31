/**
 * App-side opener for the Artifacts panel. Registered once from App.tsx (which
 * owns the tab actions) so the dialog stays a dumb list; mirrors the
 * `setLspNavigator` pattern.
 */
export type ArtifactOpener = {
  openFile: (path: string) => void;
  openPreview: (url: string) => void;
  openCanvas: (html: string, title?: string) => void;
};

let current: ArtifactOpener | null = null;

export function setArtifactOpener(opener: ArtifactOpener | null): void {
  current = opener;
}

export function artifactOpener(): ArtifactOpener | null {
  return current;
}
