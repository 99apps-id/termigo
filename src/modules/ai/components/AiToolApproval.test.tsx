import { describe, expect, it, vi } from "vitest";
import { PreviewBlock } from "./AiToolApproval";

describe("PreviewBlock", () => {
  it("renders bash command in pre tag when not editing", () => {
    const el = PreviewBlock({
      toolName: "bash_run",
      input: { command: "git status", cwd: "/home/user/repo" },
      isEditing: false,
      setIsEditing: vi.fn(),
      editedCommand: "git status",
      setEditedCommand: vi.fn(),
      initialCommand: "git status",
      onReset: vi.fn(),
    });

    expect(el).toBeDefined();
    expect(el.props.className).toContain("space-y-1.5");
  });

  it("renders textarea when isEditing is true", () => {
    const setIsEditing = vi.fn();
    const setEditedCommand = vi.fn();
    const el = PreviewBlock({
      toolName: "bash_run",
      input: { command: "npm test" },
      isEditing: true,
      setIsEditing,
      editedCommand: "npm test -- --run",
      setEditedCommand,
      initialCommand: "npm test",
      onReset: vi.fn(),
    });

    expect(el).toBeDefined();
    // Children contain the header bar and the textarea
    const children = el.props.children;
    const textarea = children[1];
    expect(textarea.type).toBe("textarea");
    expect(textarea.props.value).toBe("npm test -- --run");

    // Simulate typing into textarea
    textarea.props.onChange({ target: { value: "npm test -- --watch" } });
    expect(setEditedCommand).toHaveBeenCalledWith("npm test -- --watch");
  });

  it("shows Reset button when command is modified", () => {
    const onReset = vi.fn();
    const el = PreviewBlock({
      toolName: "bash_run",
      input: { command: "cargo check" },
      isEditing: false,
      setIsEditing: vi.fn(),
      editedCommand: "cargo test",
      initialCommand: "cargo check",
      setEditedCommand: vi.fn(),
      onReset,
    });

    const header = el.props.children[0];
    const actions = header.props.children[1];
    const buttons = actions.props.children;
    // buttons[0] is the Reset button because isModified is true
    const resetButton = buttons[0];
    expect(resetButton).toBeDefined();
    expect(resetButton.props.title).toContain("Reset command");

    resetButton.props.onClick();
    expect(onReset).toHaveBeenCalledOnce();
  });

  it("toggles editing mode when Edit button is clicked", () => {
    const setIsEditing = vi.fn();
    const el = PreviewBlock({
      toolName: "bash_run",
      input: { command: "cargo build" },
      isEditing: false,
      setIsEditing,
      editedCommand: "cargo build",
      initialCommand: "cargo build",
      setEditedCommand: vi.fn(),
      onReset: vi.fn(),
    });

    const header = el.props.children[0];
    const actions = header.props.children[1];
    const buttons = actions.props.children;
    // buttons[1] is the Edit button when not modified
    const editButton = buttons[1];
    expect(editButton).toBeDefined();

    editButton.props.onClick();
    expect(setIsEditing).toHaveBeenCalledWith(true);
  });

  it("renders write_file preview with line count hint", () => {
    const el = PreviewBlock({
      toolName: "write_file",
      input: { path: "src/app.ts", content: "console.log(1);\nconsole.log(2);" },
      isEditing: false,
      setIsEditing: vi.fn(),
      editedCommand: "",
      initialCommand: "",
      setEditedCommand: vi.fn(),
      onReset: vi.fn(),
    });

    expect(el).toBeDefined();
    const textChildren = el.props.children;
    expect(textChildren[0].props.children).toBe("src/app.ts");
    expect(textChildren[1].props.children.join("")).toContain("2 lines");
  });

  it("renders create_directory preview with target path", () => {
    const el = PreviewBlock({
      toolName: "create_directory",
      input: { path: "src/components/new-dir" },
      isEditing: false,
      setIsEditing: vi.fn(),
      editedCommand: "",
      initialCommand: "",
      setEditedCommand: vi.fn(),
      onReset: vi.fn(),
    });

    expect(el).toBeDefined();
    expect(el.props.children).toBe("src/components/new-dir");
  });
});

describe("Edited command application in tool approval responder", () => {
  it("updates part.input.command when an edited command is provided on approval", () => {
    const part = {
      type: "tool-bash_run",
      state: "approval-requested" as const,
      approval: { id: "app-123" },
      input: { command: "cargo test --locked" },
    };
    const onApproval = vi.fn();

    const onRespond = (approved: boolean, editedCommand?: string) => {
      if (
        approved &&
        editedCommand !== undefined &&
        typeof part.input === "object" &&
        part.input !== null
      ) {
        (part.input as Record<string, unknown>).command = editedCommand;
      }
      onApproval(part.approval.id, approved);
    };

    onRespond(true, "cargo test --locked --lib my_test");
    expect(part.input.command).toBe("cargo test --locked --lib my_test");
    expect(onApproval).toHaveBeenCalledWith("app-123", true);
  });

  it("keeps original part.input.command when approval is granted without edits", () => {
    const part = {
      type: "tool-bash_run",
      state: "approval-requested" as const,
      approval: { id: "app-456" },
      input: { command: "git status" },
    };
    const onApproval = vi.fn();

    const onRespond = (approved: boolean, editedCommand?: string) => {
      if (
        approved &&
        editedCommand !== undefined &&
        typeof part.input === "object" &&
        part.input !== null
      ) {
        (part.input as Record<string, unknown>).command = editedCommand;
      }
      onApproval(part.approval.id, approved);
    };

    onRespond(true);
    expect(part.input.command).toBe("git status");
    expect(onApproval).toHaveBeenCalledWith("app-456", true);
  });
});
