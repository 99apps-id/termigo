import { Button } from "@/components/ui/button";
import { SidebarRightIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useSshActiveSessionStore } from "./sshActiveSession";
import { useSshRightPanelStore } from "./sshRightPanelStore";

/**
 * Show/hide the remote file panel.
 *
 * Mirrors the sidebar toggle on the left, on the side the panel actually opens.
 * Closing the panel used to be one-way: the only way back was a menu item
 * buried in the SSH connection list, which is not where anyone looks for "put
 * back the panel I just closed".
 *
 * Rendered only while a session is live, because the panel only exists then. A
 * control that visibly toggles nothing is worse than no control.
 */
export function SshPanelToggle() {
  const session = useSshActiveSessionStore((s) => s.session);
  const open = useSshRightPanelStore((s) => s.open);
  const toggle = useSshRightPanelStore((s) => s.toggle);

  if (!session) return null;

  const label = `${open ? "Hide" : "Show"} remote files (${session.hostLabel})`;
  return (
    <Button
      onClick={toggle}
      title={label}
      aria-label={label}
      aria-pressed={open}
      variant="ghost"
      size="icon-sm"
      className={`shrink-0 rounded-md hover:bg-accent hover:text-foreground ${
        open ? "text-foreground" : "text-muted-foreground"
      }`}
    >
      <HugeiconsIcon icon={SidebarRightIcon} size={18} strokeWidth={1.75} />
    </Button>
  );
}
