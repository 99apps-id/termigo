package coder

import (
	"context"
	"strings"
	"testing"
)

func todoEnv() *Env { return &Env{Session: &Session{}} }

func runTodo(t *testing.T, tool Tool, env *Env, args map[string]any) Result {
	t.Helper()
	result, err := tool.Run(context.Background(), env, args)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

func plan(items ...[2]string) map[string]any {
	list := make([]any, len(items))
	for index, item := range items {
		list[index] = map[string]any{"content": item[0], "status": item[1]}
	}
	return map[string]any{"todos": list}
}

func TestTodoWriteKeepsIDsAndOneInProgress(t *testing.T) {
	env := todoEnv()
	runTodo(t, &todoWriteTool{}, env, plan([2]string{"read code", "in_progress"}, [2]string{"fix bug", "pending"}))
	result := runTodo(t, &todoWriteTool{}, env, plan(
		[2]string{"read code", "completed"}, [2]string{"fix bug", "in_progress"}, [2]string{"add test", "in_progress"}))
	todos := env.Session.Todos()
	if todos[0].ID != 1 || todos[1].ID != 2 || todos[2].ID != 3 {
		t.Fatalf("a step that keeps its text keeps its id: %+v", todos)
	}
	if todos[1].Status != todoPending || todos[2].Status != todoInProgress {
		t.Fatalf("only the last in_progress stays: %+v", todos)
	}
	if !strings.Contains(result.Output, "[x] 1. read code") || !strings.Contains(result.Output, "1 of 3 done") {
		t.Fatalf("the plan is repeated back: %q", result.Output)
	}
}

func TestTodoUpdateByIDAndByText(t *testing.T) {
	env := todoEnv()
	runTodo(t, &todoWriteTool{}, env, plan([2]string{"read code", "in_progress"}, [2]string{"fix the parser", "pending"}, [2]string{"fix the lexer", "pending"}))

	if r := runTodo(t, &todoUpdateTool{}, env, map[string]any{"id": "1", "status": "done"}); r.IsError {
		t.Fatalf("by id: %q", r.Output)
	}
	if r := runTodo(t, &todoUpdateTool{}, env, map[string]any{"match": "parser", "status": "in_progress"}); r.IsError {
		t.Fatalf("by text: %q", r.Output)
	}
	if r := runTodo(t, &todoUpdateTool{}, env, map[string]any{"match": "fix", "status": "completed"}); !r.IsError || !strings.Contains(r.Output, "more than one") {
		t.Fatalf("an ambiguous match is refused: %+v", r)
	}
	if r := runTodo(t, &todoUpdateTool{}, env, map[string]any{"id": "9", "status": "completed"}); !r.IsError {
		t.Fatal("an unknown id is an error")
	}
	todos := env.Session.Todos()
	if todos[0].Status != todoCompleted || todos[1].Status != todoInProgress {
		t.Fatalf("todos = %+v", todos)
	}
	runTodo(t, &todoUpdateTool{}, env, map[string]any{"id": "3", "status": "in_progress"})
	if got := env.Session.Todos()[1].Status; got != todoPending {
		t.Fatalf("starting another step pauses the first, got %s", got)
	}
}

func TestTodoReadAndMissingSession(t *testing.T) {
	env := todoEnv()
	if r := runTodo(t, &todoReadTool{}, env, nil); r.Output != "The plan is empty." {
		t.Fatalf("read = %q", r.Output)
	}
	if r := runTodo(t, &todoUpdateTool{}, env, map[string]any{"id": "1", "status": "done"}); !r.IsError {
		t.Fatal("updating before a plan exists says so")
	}
	if r := runTodo(t, &todoWriteTool{}, &Env{}, plan([2]string{"x", "pending"})); !r.IsError {
		t.Fatal("without a session the plan cannot be kept")
	}
}

func TestPlanSurvivesSaveAndLoadShape(t *testing.T) {
	env := todoEnv()
	runTodo(t, &todoWriteTool{}, env, plan([2]string{"a", "pending"}))
	if len(env.Session.Plan) != 1 {
		t.Fatal("the plan lives on the session, which is what gets saved")
	}
}
