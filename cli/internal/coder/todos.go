package coder

import (
	"context"
	"fmt"
	"strconv"
	"strings"
)

// Todo is one step of the agent's plan.
type Todo struct {
	ID      int    `json:"id"`
	Content string `json:"content"`
	Status  string `json:"status"`
}

const (
	todoPending    = "pending"
	todoInProgress = "in_progress"
	todoCompleted  = "completed"
)

func normalizeStatus(status string) (string, bool) {
	switch strings.ToLower(strings.TrimSpace(strings.ReplaceAll(status, "-", "_"))) {
	case "", "pending", "todo", "open":
		return todoPending, true
	case "in_progress", "active", "doing", "started":
		return todoInProgress, true
	case "completed", "done", "complete", "finished":
		return todoCompleted, true
	}
	return "", false
}

// renderTodos is the plan as the model and the operator read it. The tool
// result repeats it in full so a step the model forgot is in front of it again.
func renderTodos(todos []Todo) string {
	if len(todos) == 0 {
		return "The plan is empty."
	}
	var out strings.Builder
	done := 0
	for _, todo := range todos {
		mark := "[ ]"
		switch todo.Status {
		case todoCompleted:
			mark, done = "[x]", done+1
		case todoInProgress:
			mark = "[>]"
		}
		fmt.Fprintf(&out, "%s %d. %s\n", mark, todo.ID, todo.Content)
	}
	fmt.Fprintf(&out, "%d of %d done.", done, len(todos))
	if done < len(todos) {
		out.WriteString(" Mark each step completed with todo_update as soon as it is finished.")
	}
	return out.String()
}

// settleTodos keeps one step in progress at most: the last one marked wins and
// the others go back to pending.
func settleTodos(todos []Todo) {
	last := -1
	for index, todo := range todos {
		if todo.Status == todoInProgress {
			last = index
		}
	}
	for index := range todos {
		if todos[index].Status == todoInProgress && index != last {
			todos[index].Status = todoPending
		}
	}
}

// findTodo resolves an id, or text that matches exactly one step.
func findTodo(todos []Todo, id string, match string) (int, error) {
	if id = strings.TrimSpace(id); id != "" {
		number, err := strconv.Atoi(strings.TrimPrefix(id, "#"))
		if err != nil {
			return -1, fmt.Errorf("id %q is not a number", id)
		}
		for index, todo := range todos {
			if todo.ID == number {
				return index, nil
			}
		}
		return -1, fmt.Errorf("no step with id %d", number)
	}
	match = strings.ToLower(strings.TrimSpace(match))
	if match == "" {
		return -1, fmt.Errorf("give the id of the step, or text that identifies it")
	}
	found := -1
	for index, todo := range todos {
		if strings.Contains(strings.ToLower(todo.Content), match) {
			if found >= 0 {
				return -1, fmt.Errorf("%q matches more than one step, use the id", match)
			}
			found = index
		}
	}
	if found < 0 {
		return -1, fmt.Errorf("no step matches %q", match)
	}
	return found, nil
}

func todoSession(env *Env) *Session {
	if env == nil {
		return nil
	}
	return env.Session
}

const noTodoSession = "The plan cannot be kept in this run."

type todoWriteTool struct{}

func (t *todoWriteTool) Name() string                    { return "todo_write" }
func (t *todoWriteTool) Aliases() []string               { return []string{"update_plan", "set_todos"} }
func (t *todoWriteTool) Mutating() bool                  { return false }
func (t *todoWriteTool) Risk() Risk                      { return RiskEdit }
func (t *todoWriteTool) Label(map[string]any) string     { return "Updating the plan" }
func (t *todoWriteTool) DoneLabel(map[string]any) string { return "Updated the plan" }
func (t *todoWriteTool) Description() string {
	return "Write the task plan for work that takes three or more steps: the whole list, replacing the old one. Keep at most one step in_progress and finish steps one at a time. Steps that keep their text keep their id."
}
func (t *todoWriteTool) Schema() map[string]any {
	return object(map[string]any{
		"todos": arrayProp("The full plan, in order.", object(map[string]any{
			"content": strProp("What the step does, in the imperative."),
			"status":  strProp("pending, in_progress or completed."),
		}, "content")),
	}, "todos")
}

func (t *todoWriteTool) Run(_ context.Context, env *Env, args map[string]any) (Result, error) {
	session := todoSession(env)
	if session == nil {
		return Result{Output: noTodoSession, IsError: true}, nil
	}
	raw, _ := args["todos"].([]any)
	if len(raw) == 0 {
		return Result{Output: "todos must list at least one step. Use todo_read to see the current plan.", IsError: true}, nil
	}
	previous := session.Todos()
	todos := make([]Todo, 0, len(raw))
	next := 1
	for _, todo := range previous {
		if todo.ID >= next {
			next = todo.ID + 1
		}
	}
	taken := map[int]bool{}
	for _, item := range raw {
		fields, _ := item.(map[string]any)
		content := strings.TrimSpace(argString(fields, "content", "task", "text", "title"))
		if content == "" {
			continue
		}
		status, ok := normalizeStatus(argString(fields, "status"))
		if !ok {
			return Result{Output: fmt.Sprintf("Unknown status %q. Use pending, in_progress or completed.", argString(fields, "status")), IsError: true}, nil
		}
		entry := Todo{Content: content, Status: status}
		for _, old := range previous {
			if !taken[old.ID] && strings.EqualFold(old.Content, content) {
				entry.ID = old.ID
				taken[old.ID] = true
				break
			}
		}
		if entry.ID == 0 {
			entry.ID = next
			next++
		}
		todos = append(todos, entry)
	}
	if len(todos) == 0 {
		return Result{Output: "No step had any text.", IsError: true}, nil
	}
	settleTodos(todos)
	session.setTodos(todos)
	return Result{Output: renderTodos(todos), Display: fmt.Sprintf("%d steps", len(todos))}, nil
}

type todoUpdateTool struct{}

func (t *todoUpdateTool) Name() string      { return "todo_update" }
func (t *todoUpdateTool) Aliases() []string { return []string{"complete_todo", "mark_todo"} }
func (t *todoUpdateTool) Mutating() bool    { return false }
func (t *todoUpdateTool) Risk() Risk        { return RiskEdit }
func (t *todoUpdateTool) Label(a map[string]any) string {
	return "Marking step " + todoRef(a)
}
func (t *todoUpdateTool) DoneLabel(a map[string]any) string { return "Marked step " + todoRef(a) }
func (t *todoUpdateTool) Description() string {
	return "Change one step of the plan. Call it with status completed right after finishing a step, and in_progress when starting the next. Identify the step by id, or by text that matches only one."
}
func (t *todoUpdateTool) Schema() map[string]any {
	return object(map[string]any{
		"id":     strProp("The step number shown in the plan."),
		"match":  strProp("Text from the step, when the id is not at hand."),
		"status": strProp("pending, in_progress or completed."),
	}, "status")
}

func todoRef(a map[string]any) string {
	if id := argString(a, "id"); id != "" {
		return "#" + strings.TrimPrefix(id, "#")
	}
	return Shorten(argString(a, "match"), 30)
}

func (t *todoUpdateTool) Run(_ context.Context, env *Env, args map[string]any) (Result, error) {
	session := todoSession(env)
	if session == nil {
		return Result{Output: noTodoSession, IsError: true}, nil
	}
	status, ok := normalizeStatus(argString(args, "status"))
	if !ok || argString(args, "status") == "" {
		return Result{Output: "status must be pending, in_progress or completed.", IsError: true}, nil
	}
	todos := session.Todos()
	if len(todos) == 0 {
		return Result{Output: "There is no plan yet. Write one with todo_write.", IsError: true}, nil
	}
	index, err := findTodo(todos, argString(args, "id"), argString(args, "match"))
	if err != nil {
		return Result{Output: err.Error() + "\n" + renderTodos(todos), IsError: true}, nil
	}
	todos[index].Status = status
	if status == todoInProgress {
		for other := range todos {
			if other != index && todos[other].Status == todoInProgress {
				todos[other].Status = todoPending
			}
		}
	}
	session.setTodos(todos)
	return Result{Output: renderTodos(todos), Display: todos[index].Content}, nil
}

type todoReadTool struct{}

func (t *todoReadTool) Name() string                    { return "todo_read" }
func (t *todoReadTool) Aliases() []string               { return nil }
func (t *todoReadTool) Mutating() bool                  { return false }
func (t *todoReadTool) Risk() Risk                      { return RiskEdit }
func (t *todoReadTool) Label(map[string]any) string     { return "Reading the plan" }
func (t *todoReadTool) DoneLabel(map[string]any) string { return "Read the plan" }
func (t *todoReadTool) Description() string {
	return "Show the current task plan with the status of each step."
}
func (t *todoReadTool) Schema() map[string]any { return object(map[string]any{}) }

func (t *todoReadTool) Run(_ context.Context, env *Env, _ map[string]any) (Result, error) {
	session := todoSession(env)
	if session == nil {
		return Result{Output: noTodoSession, IsError: true}, nil
	}
	return Result{Output: renderTodos(session.Todos())}, nil
}
