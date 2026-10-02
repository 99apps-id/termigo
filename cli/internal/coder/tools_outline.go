package coder

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const maxOutlineLines = 250

type codeOutlineTool struct{}

func (t *codeOutlineTool) Name() string      { return "code_outline" }
func (t *codeOutlineTool) Aliases() []string { return []string{"outline", "symbols"} }
func (t *codeOutlineTool) Mutating() bool    { return false }
func (t *codeOutlineTool) Risk() Risk        { return RiskEdit }
func (t *codeOutlineTool) Label(a map[string]any) string {
	return "Extracting outline from " + Shorten(argString(a, "path", "file"), 40)
}
func (t *codeOutlineTool) DoneLabel(a map[string]any) string {
	return "Extracted outline from " + Shorten(argString(a, "path", "file"), 40)
}
func (t *codeOutlineTool) Description() string {
	return "Extract structural outline and symbol declarations (functions, methods, types, classes, interfaces, or markdown headings) with line numbers from a file without reading the full implementation body."
}
func (t *codeOutlineTool) Schema() map[string]any {
	return object(map[string]any{
		"path":  strProp("File path to outline."),
		"depth": intProp("Maximum nesting depth to show (for classes, structs, headings), 1 to 5. Defaults to 2."),
	}, "path")
}

func (t *codeOutlineTool) Run(ctx context.Context, env *Env, args map[string]any) (Result, error) {
	path := argString(args, "path", "file", "filename")
	if strings.TrimSpace(path) == "" {
		return Result{Output: "Path is required.", IsError: true}, nil
	}

	resolved := resolvePath(env, path)
	if err := checkWorkspacePath(env, resolved); err != nil {
		return Result{Output: err.Error(), IsError: true}, nil
	}

	data, err := os.ReadFile(resolved)
	if err != nil {
		return Result{Output: fmt.Sprintf("read %s: %v", displayPath(env, resolved), err), IsError: true}, nil
	}

	depth := argInt(args, "depth", 2, 1, 5)
	ext := strings.ToLower(filepath.Ext(resolved))

	var lines []string
	switch ext {
	case ".go":
		lines, err = outlineGo(data, depth)
	case ".md", ".markdown":
		lines = outlineMarkdown(data, depth)
	case ".py":
		lines = outlinePython(data, depth)
	case ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs":
		lines = outlineTypeScript(data, depth)
	case ".rs":
		lines = outlineRust(data, depth)
	default:
		lines = outlineGeneric(data)
	}

	if err != nil {
		return Result{Output: fmt.Sprintf("outline %s: %v", displayPath(env, resolved), err), IsError: true}, nil
	}

	if len(lines) == 0 {
		return Result{Output: fmt.Sprintf("No symbols or declarations found in %s.", displayPath(env, resolved))}, nil
	}

	truncated := false
	if len(lines) > maxOutlineLines {
		lines = lines[:maxOutlineLines]
		truncated = true
	}

	var sb strings.Builder
	fmt.Fprintf(&sb, "// Outline of %s (%d symbols)\n\n", displayPath(env, resolved), len(lines))
	sb.WriteString(strings.Join(lines, "\n"))
	if truncated {
		fmt.Fprintf(&sb, "\n\n... (additional symbols omitted, showing first %d)", maxOutlineLines)
	}

	return Result{Output: sb.String()}, nil
}

func outlineGo(data []byte, maxDepth int) ([]string, error) {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, "", data, parser.SkipObjectResolution)
	if err != nil {
		// If parse fails (e.g. fragment or syntax error), fall back to generic scanner
		return outlineGeneric(data), nil
	}

	var lines []string
	lines = append(lines, fmt.Sprintf("line %d: package %s", fset.Position(node.Package).Line, node.Name.Name))

	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			switch d.Tok {
			case token.TYPE:
				for _, spec := range d.Specs {
					ts, ok := spec.(*ast.TypeSpec)
					if !ok {
						continue
					}
					pos := fset.Position(ts.Pos())
					switch typeDef := ts.Type.(type) {
					case *ast.StructType:
						lines = append(lines, fmt.Sprintf("line %d: type %s struct (%d fields)", pos.Line, ts.Name.Name, len(typeDef.Fields.List)))
						if maxDepth >= 2 {
							for _, field := range typeDef.Fields.List {
								fieldType := nodeString(fset, field.Type)
								for _, name := range field.Names {
									lines = append(lines, fmt.Sprintf("    line %d: %s %s", fset.Position(name.Pos()).Line, name.Name, fieldType))
								}
							}
						}
					case *ast.InterfaceType:
						lines = append(lines, fmt.Sprintf("line %d: type %s interface (%d methods)", pos.Line, ts.Name.Name, len(typeDef.Methods.List)))
						if maxDepth >= 2 {
							for _, method := range typeDef.Methods.List {
								lines = append(lines, fmt.Sprintf("    line %d: %s", fset.Position(method.Pos()).Line, nodeString(fset, method.Type)))
							}
						}
					default:
						lines = append(lines, fmt.Sprintf("line %d: type %s %s", pos.Line, ts.Name.Name, nodeString(fset, ts.Type)))
					}
				}
			}
		case *ast.FuncDecl:
			pos := fset.Position(d.Pos())
			var sig strings.Builder
			if d.Recv != nil && len(d.Recv.List) > 0 {
				recvType := nodeString(fset, d.Recv.List[0].Type)
				fmt.Fprintf(&sig, "(%s) ", recvType)
			}
			sig.WriteString(d.Name.Name)
			sig.WriteString(formatFuncType(fset, d.Type))
			lines = append(lines, fmt.Sprintf("line %d: func %s", pos.Line, sig.String()))
		}
	}
	return lines, nil
}

func formatFuncType(fset *token.FileSet, ft *ast.FuncType) string {
	var sb strings.Builder
	sb.WriteString("(")
	if ft.Params != nil {
		var params []string
		for _, param := range ft.Params.List {
			typ := nodeString(fset, param.Type)
			if len(param.Names) > 0 {
				var names []string
				for _, n := range param.Names {
					names = append(names, n.Name)
				}
				params = append(params, fmt.Sprintf("%s %s", strings.Join(names, ", "), typ))
			} else {
				params = append(params, typ)
			}
		}
		sb.WriteString(strings.Join(params, ", "))
	}
	sb.WriteString(")")
	if ft.Results != nil && len(ft.Results.List) > 0 {
		sb.WriteString(" ")
		if len(ft.Results.List) == 1 && len(ft.Results.List[0].Names) == 0 {
			sb.WriteString(nodeString(fset, ft.Results.List[0].Type))
		} else {
			sb.WriteString("(")
			var results []string
			for _, res := range ft.Results.List {
				typ := nodeString(fset, res.Type)
				if len(res.Names) > 0 {
					var names []string
					for _, n := range res.Names {
						names = append(names, n.Name)
					}
					results = append(results, fmt.Sprintf("%s %s", strings.Join(names, ", "), typ))
				} else {
					results = append(results, typ)
				}
			}
			sb.WriteString(strings.Join(results, ", "))
			sb.WriteString(")")
		}
	}
	return sb.String()
}

func nodeString(fset *token.FileSet, node ast.Node) string {
	var buf bytes.Buffer
	_ = printer.Fprint(&buf, fset, node)
	return buf.String()
}

func outlineMarkdown(data []byte, maxDepth int) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNum := 1
	for scanner.Scan() {
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if strings.HasPrefix(trimmed, "#") {
			level := 0
			for level < len(trimmed) && trimmed[level] == '#' {
				level++
			}
			if level <= maxDepth && level < len(trimmed) && trimmed[level] == ' ' {
				title := strings.TrimSpace(trimmed[level:])
				indent := strings.Repeat("  ", level-1)
				lines = append(lines, fmt.Sprintf("line %d: %s%s %s", lineNum, indent, strings.Repeat("#", level), title))
			}
		}
		lineNum++
	}
	return lines
}

var (
	pyClassRe = regexp.MustCompile(`^(class\s+[A-Za-z0-9_]+(\(.*?\))?):`)
	pyFuncRe  = regexp.MustCompile(`^(?:async\s+)?def\s+([A-Za-z0-9_]+\(.*?\)):`)
)

func outlinePython(data []byte, maxDepth int) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNum := 1
	for scanner.Scan() {
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if strings.HasPrefix(trimmed, "#") || trimmed == "" {
			lineNum++
			continue
		}
		indent := len(text) - len(strings.TrimLeft(text, " "))
		depth := indent / 4

		if matches := pyClassRe.FindStringSubmatch(trimmed); len(matches) > 1 {
			lines = append(lines, fmt.Sprintf("line %d: %s%s", lineNum, strings.Repeat("  ", depth), matches[1]))
		} else if matches := pyFuncRe.FindStringSubmatch(trimmed); len(matches) > 1 {
			lines = append(lines, fmt.Sprintf("line %d: %sdef %s", lineNum, strings.Repeat("  ", depth), matches[1]))
		}
		lineNum++
	}
	return lines
}

var (
	tsDeclRe = regexp.MustCompile(`^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function\s+[A-Za-z0-9_]+|class\s+[A-Za-z0-9_]+|interface\s+[A-Za-z0-9_]+|type\s+[A-Za-z0-9_]+|(?:const|let|var)\s+[A-Za-z0-9_]+\s*=\s*(?:async\s+)?(?:\(.*?\)|[A-Za-z0-9_]+)\s*=>)`)
)

func outlineTypeScript(data []byte, maxDepth int) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNum := 1
	for scanner.Scan() {
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if strings.HasPrefix(trimmed, "//") || strings.HasPrefix(trimmed, "/*") || trimmed == "" {
			lineNum++
			continue
		}
		if matches := tsDeclRe.FindStringSubmatch(trimmed); len(matches) > 1 {
			lines = append(lines, fmt.Sprintf("line %d: %s", lineNum, matches[1]))
		}
		lineNum++
	}
	return lines
}

var (
	rsDeclRe = regexp.MustCompile(`^(?:pub(?:\(.*?\))?\s+)?(?:async\s+)?(fn\s+[A-Za-z0-9_]+|struct\s+[A-Za-z0-9_]+|enum\s+[A-Za-z0-9_]+|trait\s+[A-Za-z0-9_]+|impl\s+[A-Za-z0-9_]+)`)
)

func outlineRust(data []byte, maxDepth int) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNum := 1
	for scanner.Scan() {
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if strings.HasPrefix(trimmed, "//") || trimmed == "" {
			lineNum++
			continue
		}
		if matches := rsDeclRe.FindStringSubmatch(trimmed); len(matches) > 1 {
			lines = append(lines, fmt.Sprintf("line %d: %s", lineNum, matches[1]))
		}
		lineNum++
	}
	return lines
}

var genericDeclRe = regexp.MustCompile(`^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(?:func|function|def|fn|class|interface|struct)\s+[A-Za-z0-9_]+`)

func outlineGeneric(data []byte) []string {
	var lines []string
	scanner := bufio.NewScanner(bytes.NewReader(data))
	lineNum := 1
	for scanner.Scan() {
		text := scanner.Text()
		trimmed := strings.TrimSpace(text)
		if match := genericDeclRe.FindString(trimmed); match != "" {
			lines = append(lines, fmt.Sprintf("line %d: %s", lineNum, match))
		}
		lineNum++
	}
	return lines
}
