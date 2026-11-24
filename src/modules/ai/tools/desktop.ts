import { IS_MAC, IS_WINDOWS } from "@/lib/platform";
import { tool } from "ai";
import { z } from "zod";
import { native } from "../lib/native";
import {
  checkReadableCanonical,
  checkWritableCanonical,
} from "../lib/security";
import { resolvePath, type ToolContext } from "./context";

export function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

export function psQuote(arg: string): string {
  return `'${arg.replace(/'/g, "''")}'`;
}

export function sanitizeAppTarget(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || /[\r\n\0]/.test(trimmed)) return null;
  return trimmed;
}

export function sanitizeKeyCombo(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || !/^[a-zA-Z0-9_+ -]+$/.test(trimmed)) return null;
  return trimmed;
}

function defaultScreenshotPath(cwd: string): string {
  const base = cwd.replace(/[\\/]+$/, "");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `${base}/.termigo/screenshots/desktop-${stamp}.png`;
}

export function buildDesktopTools(ctx: ToolContext) {
  return {
    desktop_launch_app: tool({
      description:
        "Launch a desktop application (e.g. 'blender', 'gimp', 'inkscape', 'libreoffice', 'code', 'firefox') or open a file/URL with the OS default handler, detached in the background so it does not block the agent.",
      inputSchema: z.object({
        app: z
          .string()
          .min(1)
          .describe(
            "Application binary/name (e.g. 'blender', 'gimp', 'libreoffice') or file/URL to open.",
          ),
        args: z
          .array(z.string())
          .optional()
          .describe(
            "Optional command-line arguments passed to the application.",
          ),
        open_with_default: z
          .boolean()
          .optional()
          .describe(
            "When true, open `app` as a file or URL using xdg-open / open / Start-Process.",
          ),
      }),
      execute: async ({ app, args, open_with_default }) => {
        const cleanApp = sanitizeAppTarget(app);
        if (!cleanApp) {
          return { ok: false, error: "Invalid application name or target." };
        }
        const argv = args ?? [];
        const cwd = ctx.getCwd() ?? ".";

        let cmd: string;
        if (IS_WINDOWS) {
          const argList =
            argv.length > 0
              ? ` -ArgumentList @(${argv.map(psQuote).join(", ")})`
              : "";
          cmd = `Start-Process -FilePath ${psQuote(cleanApp)}${argList}`;
        } else if (IS_MAC) {
          if (open_with_default) {
            cmd = `open ${shellQuote(cleanApp)}`;
          } else {
            const quotedArgs = argv.map(shellQuote).join(" ");
            cmd = `if command -v ${shellQuote(cleanApp)} >/dev/null 2>&1; then nohup ${shellQuote(cleanApp)} ${quotedArgs} >/dev/null 2>&1 & echo "PID=$!"; else open -a ${shellQuote(cleanApp)}${argv.length ? ` --args ${quotedArgs}` : ""}; fi`;
          }
        } else {
          // Linux
          if (open_with_default) {
            cmd = `nohup xdg-open ${shellQuote(cleanApp)} >/dev/null 2>&1 & echo "PID=$!"`;
          } else {
            const quotedArgs = argv.map(shellQuote).join(" ");
            cmd = [
              `if ! command -v ${shellQuote(cleanApp)} >/dev/null 2>&1; then echo "__APP_NOT_FOUND__"; exit 2; fi`,
              `nohup ${shellQuote(cleanApp)} ${quotedArgs} >/dev/null 2>&1 &`,
              `echo "PID=$!"`,
            ].join("\n");
          }
        }

        try {
          const res = await native.runCommand(cmd, cwd, 15);
          const out = (res.stdout ?? "").trim();
          if (out.includes("__APP_NOT_FOUND__")) {
            return {
              ok: false,
              app: cleanApp,
              error: `Application '${cleanApp}' is not installed or not in PATH.`,
            };
          }
          if (res.exit_code !== 0) {
            return {
              ok: false,
              app: cleanApp,
              error:
                (res.stderr ?? "").trim() ||
                `Failed to launch '${cleanApp}' (exit ${res.exit_code}).`,
            };
          }
          const pidMatch = out.match(/PID=(\d+)/);
          return {
            ok: true,
            app: cleanApp,
            ...(pidMatch ? { pid: Number(pidMatch[1]) } : {}),
            output: out || `Launched ${cleanApp}`,
          };
        } catch (e) {
          return {
            ok: false,
            app: cleanApp,
            error: `Launch failed: ${String(e)}`,
          };
        }
      },
    }),

    desktop_list_windows: tool({
      description:
        "List visible top-level desktop application windows (ID, app class, title) so the agent can inspect running GUI apps and choose a window to focus or capture.",
      inputSchema: z.object({}),
      execute: async () => {
        const cwd = ctx.getCwd() ?? ".";
        const cmd = IS_WINDOWS
          ? `Get-Process | Where-Object { $_.MainWindowTitle -ne '' } | Select-Object Id, ProcessName, MainWindowTitle | Format-Table -AutoSize`
          : IS_MAC
            ? `osascript -e 'tell application "System Events" to get {name, title of every window} of (every process whose visible is true)'`
            : [
                `if command -v wmctrl >/dev/null 2>&1; then`,
                `  wmctrl -lx`,
                `elif command -v xdotool >/dev/null 2>&1; then`,
                `  for id in $(xdotool search --onlyvisible --name ".*" 2>/dev/null | head -n 50); do`,
                `    echo "$id $(xdotool getwindowname "$id" 2>/dev/null)"`,
                `  done`,
                `else`,
                `  echo "__NO_WM_TOOL__"; exit 2`,
                `fi`,
              ].join("\n");

        try {
          const res = await native.runCommand(cmd, cwd, 15);
          const out = (res.stdout ?? "").trim();
          if (out.includes("__NO_WM_TOOL__")) {
            return {
              ok: false,
              error:
                "Neither wmctrl nor xdotool is installed. Install via `sudo apt install wmctrl xdotool`.",
            };
          }
          return { ok: true, windows: out || "(no visible windows)" };
        } catch (e) {
          return { ok: false, error: `Failed to list windows: ${String(e)}` };
        }
      },
    }),

    desktop_focus_window: tool({
      description:
        "Bring a desktop application window to the foreground by matching its title or application name (e.g. 'Blender', 'Firefox', 'GIMP').",
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe("Window title or application name substring to focus."),
      }),
      execute: async ({ query }) => {
        const clean = sanitizeAppTarget(query);
        if (!clean) return { ok: false, error: "Invalid window query." };
        const cwd = ctx.getCwd() ?? ".";
        const cmd = IS_WINDOWS
          ? `$wshell = New-Object -ComObject wscript.shell; $wshell.AppActivate(${psQuote(clean)})`
          : IS_MAC
            ? `osascript -e ${shellQuote(`tell application "${clean.replace(/"/g, '\\"')}" to activate`)}`
            : [
                `if command -v wmctrl >/dev/null 2>&1; then`,
                `  wmctrl -a ${shellQuote(clean)}`,
                `elif command -v xdotool >/dev/null 2>&1; then`,
                `  WID=$(xdotool search --onlyvisible --name ${shellQuote(clean)} 2>/dev/null | head -n 1)`,
                `  [ -n "$WID" ] && xdotool windowactivate --sync "$WID" || { echo "Window not found"; exit 1; }`,
                `else`,
                `  echo "__NO_WM_TOOL__"; exit 2`,
                `fi`,
              ].join("\n");

        try {
          const res = await native.runCommand(cmd, cwd, 15);
          const out = (res.stdout ?? "").trim();
          if (out.includes("__NO_WM_TOOL__")) {
            return {
              ok: false,
              error:
                "Neither wmctrl nor xdotool is installed. Install via `sudo apt install wmctrl xdotool`.",
            };
          }
          if (res.exit_code !== 0) {
            return {
              ok: false,
              query: clean,
              error:
                (res.stderr ?? "").trim() ||
                out ||
                `Could not focus window matching '${clean}'.`,
            };
          }
          return { ok: true, focused: clean };
        } catch (e) {
          return { ok: false, error: `Focus window failed: ${String(e)}` };
        }
      },
    }),

    desktop_screenshot: tool({
      description:
        "Capture a screenshot of the desktop (full screen or active window) to a PNG file in the workspace so the agent can visually inspect running desktop applications (like Blender) via read_image or send it to Telegram.",
      inputSchema: z.object({
        output_path: z
          .string()
          .optional()
          .describe(
            "Optional workspace path for the PNG (defaults to .termigo/screenshots/desktop-<ts>.png).",
          ),
        active_window: z
          .boolean()
          .optional()
          .describe("When true, capture only the currently focused window."),
      }),
      execute: async ({ output_path, active_window }) => {
        const cwd = ctx.getCwd() ?? ".";
        const target = output_path
          ? resolvePath(output_path, cwd)
          : defaultScreenshotPath(cwd);
        const safety = await checkWritableCanonical(
          target,
          native.canonicalize,
        );
        if (!safety.ok) {
          return { ok: false, error: safety.reason, path: target };
        }
        const outPath = safety.canonical;
        const outDir = outPath.replace(/[\\/][^\\/]+$/, "");

        const cmd = IS_WINDOWS
          ? `New-Item -ItemType Directory -Force -Path ${psQuote(outDir)} | Out-Null; Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $bmp = New-Object System.Drawing.Bitmap($b.Width,$b.Height); $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $bmp.Save(${psQuote(outPath)},[System.Drawing.Imaging.ImageFormat]::Png)`
          : IS_MAC
            ? `mkdir -p ${shellQuote(outDir)} && screencapture -x ${shellQuote(outPath)}`
            : [
                `mkdir -p ${shellQuote(outDir)}`,
                `if command -v grim >/dev/null 2>&1 && [ -n "$WAYLAND_DISPLAY" ]; then`,
                `  grim ${shellQuote(outPath)}`,
                `elif command -v gnome-screenshot >/dev/null 2>&1; then`,
                `  gnome-screenshot ${active_window ? "-w " : ""}-f ${shellQuote(outPath)}`,
                `elif command -v scrot >/dev/null 2>&1; then`,
                `  scrot ${active_window ? "-u " : ""}${shellQuote(outPath)}`,
                `elif command -v import >/dev/null 2>&1; then`,
                `  import -window root ${shellQuote(outPath)}`,
                `else`,
                `  echo "__NO_SCREENSHOT_TOOL__"; exit 2`,
                `fi`,
              ].join("\n");

        try {
          const res = await native.runCommand(cmd, cwd, 20);
          const out = (res.stdout ?? "").trim();
          if (out.includes("__NO_SCREENSHOT_TOOL__")) {
            return {
              ok: false,
              error:
                "No screenshot tool found. Install one of: gnome-screenshot, scrot, grim (Wayland), or imagemagick (`import`).",
            };
          }
          if (res.exit_code !== 0) {
            return {
              ok: false,
              path: outPath,
              error:
                (res.stderr ?? "").trim() ||
                `Screenshot failed with exit code ${res.exit_code}`,
            };
          }
          return { ok: true, path: outPath };
        } catch (e) {
          return { ok: false, error: `Screenshot failed: ${String(e)}` };
        }
      },
    }),

    desktop_input: tool({
      description:
        "Send GUI mouse/keyboard input to the currently focused desktop application (click at x,y, type text, press shortcut key combo like 'ctrl+s' or 'Return', or scroll).",
      inputSchema: z.object({
        action: z.enum(["click", "type_text", "press_key", "scroll"]),
        x: z.number().int().min(0).optional(),
        y: z.number().int().min(0).optional(),
        button: z.enum(["left", "middle", "right"]).optional(),
        text: z.string().optional(),
        key: z
          .string()
          .optional()
          .describe(
            "Key or combo, e.g. 'Return', 'Escape', 'ctrl+s', 'alt+F4'.",
          ),
        direction: z.enum(["up", "down"]).optional(),
        amount: z.number().int().min(1).max(20).optional(),
      }),
      execute: async (args) => {
        const cwd = ctx.getCwd() ?? ".";
        if (IS_WINDOWS || IS_MAC) {
          return {
            ok: false,
            error:
              "desktop_input currently uses xdotool on Linux X11; on macOS/Windows use blender_run_python or desktop_launch_app.",
          };
        }

        let xdoCmd = "";
        if (args.action === "click") {
          if (args.x === undefined || args.y === undefined) {
            return { ok: false, error: "x and y are required for click." };
          }
          const btn =
            args.button === "right" ? 3 : args.button === "middle" ? 2 : 1;
          xdoCmd = `xdotool mousemove --sync ${args.x} ${args.y} click ${btn}`;
        } else if (args.action === "type_text") {
          if (!args.text) {
            return { ok: false, error: "text is required for type_text." };
          }
          xdoCmd = `xdotool type --clearmodifiers --delay 12 -- ${shellQuote(args.text)}`;
        } else if (args.action === "press_key") {
          const combo = args.key ? sanitizeKeyCombo(args.key) : null;
          if (!combo) {
            return {
              ok: false,
              error: "Valid key combo is required for press_key.",
            };
          }
          xdoCmd = `xdotool key --clearmodifiers ${shellQuote(combo)}`;
        } else if (args.action === "scroll") {
          const btn = args.direction === "up" ? 4 : 5;
          const count = args.amount ?? 3;
          xdoCmd = `xdotool click --repeat ${count} ${btn}`;
        }

        const cmd = [
          `if ! command -v xdotool >/dev/null 2>&1; then echo "__NO_XDOTOOL__"; exit 2; fi`,
          xdoCmd,
        ].join("\n");

        try {
          const res = await native.runCommand(cmd, cwd, 15);
          if ((res.stdout ?? "").includes("__NO_XDOTOOL__")) {
            return {
              ok: false,
              error:
                "xdotool is not installed. Install via `sudo apt install xdotool`.",
            };
          }
          if (res.exit_code !== 0) {
            return {
              ok: false,
              error:
                (res.stderr ?? "").trim() ||
                `xdotool failed with exit code ${res.exit_code}`,
            };
          }
          return { ok: true, action: args.action };
        } catch (e) {
          return { ok: false, error: `desktop_input failed: ${String(e)}` };
        }
      },
    }),

    blender_run_python: tool({
      description:
        "Run a Python (`bpy`) script inside Blender for 3D modeling, scene creation, rendering (PNG/MP4), or exporting (.glb, .fbx, .obj, .stl, .blend). Runs headless (`--background`) by default so it is fast and scriptable; set `gui: true` to open the scene in Blender's desktop GUI.",
      inputSchema: z.object({
        script: z
          .string()
          .min(1)
          .describe("Python script using `import bpy` to run inside Blender."),
        blend_file: z
          .string()
          .optional()
          .describe(
            "Optional existing .blend file to open before running the script.",
          ),
        gui: z
          .boolean()
          .optional()
          .describe(
            "When false (default), runs headless (`blender --background`). When true, launches Blender desktop GUI with the script.",
          ),
        timeout_secs: z
          .number()
          .int()
          .min(5)
          .max(300)
          .optional()
          .describe("Execution timeout in seconds (default 120, max 300)."),
      }),
      execute: async ({ script, blend_file, gui, timeout_secs }) => {
        const cwd = ctx.getCwd() ?? ".";
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const scriptPath = `${cwd.replace(/[\\/]+$/, "")}/.termigo/blender/script-${stamp}.py`;
        const writeCheck = await checkWritableCanonical(
          scriptPath,
          native.canonicalize,
        );
        if (!writeCheck.ok) {
          return { ok: false, error: writeCheck.reason, path: scriptPath };
        }
        await native.writeFile(writeCheck.canonical, script);

        let blendArg = "";
        if (blend_file) {
          const blendAbs = resolvePath(blend_file, cwd);
          const readCheck = await checkReadableCanonical(
            blendAbs,
            native.canonicalize,
          );
          if (!readCheck.ok) {
            return { ok: false, error: readCheck.reason, path: blendAbs };
          }
          blendArg = ` ${IS_WINDOWS ? psQuote(readCheck.canonical) : shellQuote(readCheck.canonical)}`;
        }

        const timeout = timeout_secs ?? 120;
        let cmd: string;
        if (IS_WINDOWS) {
          const bg = gui ? "" : " --background";
          cmd = gui
            ? `Start-Process -FilePath 'blender' -ArgumentList @(${blend_file ? `${blendArg.trim()}, ` : ""}'--python', ${psQuote(writeCheck.canonical)})`
            : `blender${bg}${blendArg} --python ${psQuote(writeCheck.canonical)}`;
        } else {
          const pyQuoted = shellQuote(writeCheck.canonical);
          cmd = gui
            ? [
                `if ! command -v blender >/dev/null 2>&1; then echo "__NO_BLENDER__"; exit 2; fi`,
                `nohup blender${blendArg} --python ${pyQuoted} >/dev/null 2>&1 &`,
                `echo "PID=$!"`,
              ].join("\n")
            : [
                `if ! command -v blender >/dev/null 2>&1; then echo "__NO_BLENDER__"; exit 2; fi`,
                `blender --background${blendArg} --python-exit-code 1 --python ${pyQuoted}`,
              ].join("\n");
        }

        try {
          const res = await native.runCommand(cmd, cwd, timeout);
          const stdout = (res.stdout ?? "").trim();
          const stderr = (res.stderr ?? "").trim();
          if (stdout.includes("__NO_BLENDER__")) {
            return {
              ok: false,
              scriptPath: writeCheck.canonical,
              error:
                "Blender is not installed or not in PATH. Install it (e.g. `sudo apt install blender`, `sudo snap install blender --classic`, or from blender.org).",
            };
          }
          if (res.exit_code !== 0) {
            return {
              ok: false,
              scriptPath: writeCheck.canonical,
              exitCode: res.exit_code,
              stdout: stdout.slice(-4000),
              stderr: stderr.slice(-4000),
              error: `Blender exited with code ${res.exit_code}.`,
            };
          }
          return {
            ok: true,
            mode: gui ? "gui" : "headless",
            scriptPath: writeCheck.canonical,
            stdout: stdout.slice(-6000),
            ...(stderr ? { stderr: stderr.slice(-2000) } : {}),
          };
        } catch (e) {
          return {
            ok: false,
            scriptPath: writeCheck.canonical,
            error: `Blender execution failed: ${String(e)}`,
          };
        }
      },
    }),
  };
}
