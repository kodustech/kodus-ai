package observer

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// The managed account's first supported query language is intentionally
// smaller than SQL. It reads one public table; executable expressions,
// metadata relations and ambiguous syntax are refused before connecting.
const managedIdentifier = `(?:"[A-Za-z_][A-Za-z0-9_]{0,62}"|[A-Za-z_][A-Za-z0-9_]{0,62})`
const managedLiteral = `(?:'(?:[^'\\\x00]|'')*'|-?[0-9]{1,20}(?:\.[0-9]{1,20})?|NULL|TRUE|FALSE)`

var (
	managedSelect      = regexp.MustCompile(`(?is)^\s*SELECT\s+(.+?)\s+FROM\s+(?:(` + managedIdentifier + `)\s*\.\s*)?(` + managedIdentifier + `)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER\s+BY\s+(.+?))?(?:\s+LIMIT\s+([0-9]{1,4}))?\s*$`)
	managedProjection  = regexp.MustCompile(`(?i)^(` + managedIdentifier + `)(?:\s+AS\s+(` + managedIdentifier + `))?$`)
	managedAggregate   = regexp.MustCompile(`(?i)^(COUNT|MIN|MAX|SUM|AVG)\s*\(\s*(\*|` + managedIdentifier + `)\s*\)(?:\s+AS\s+(` + managedIdentifier + `))?$`)
	managedCondition   = regexp.MustCompile(`(?is)^\s*(` + managedIdentifier + `)\s*(=|<>|!=|<=|>=|<|>|IS\s+NOT|IS)\s*(` + managedLiteral + `)`)
	managedConjunction = regexp.MustCompile(`(?i)^\s+(AND|OR)\s+`)
	managedOrder       = regexp.MustCompile(`(?i)^(` + managedIdentifier + `)(?:\s+(ASC|DESC))?$`)
	errManagedQuery    = errors.New("observer: managed SQL supports a simple SELECT from one public table; use an HTTP probe for other behavior")
)

// ManagedSQLQuery validates and canonicalizes the closed subset. Table and
// aggregate namespaces are fixed, independent of any server search_path.
func ManagedSQLQuery(query string) (string, error) {
	if len(query) > 16<<10 || !utf8.ValidString(query) || strings.ContainsAny(query, ";$\\\x00") || strings.Contains(query, "--") || strings.Contains(query, "/*") || strings.Contains(query, "*/") {
		return "", errManagedQuery
	}
	m := managedSelect.FindStringSubmatch(query)
	if m == nil {
		return "", errManagedQuery
	}
	if m[2] != "" && managedName(m[2]) != "public" {
		return "", errManagedQuery
	}
	table := managedName(m[3])
	if strings.HasPrefix(strings.ToLower(table), "pg_") {
		return "", errManagedQuery
	}
	columns := strings.Split(m[1], ",")
	if len(columns) > 32 {
		return "", errManagedQuery
	}
	projections := make([]string, 0, len(columns))
	for _, column := range columns {
		column = strings.TrimSpace(column)
		if column == "*" {
			projections = append(projections, "*")
			continue
		}
		if a := managedAggregate.FindStringSubmatch(column); a != nil {
			arg := a[2]
			if arg == "*" && !strings.EqualFold(a[1], "COUNT") {
				return "", errManagedQuery
			}
			if arg != "*" {
				arg = managedQuote(arg)
			}
			result := `pg_catalog.` + strings.ToLower(a[1]) + "(" + arg + ")"
			if a[3] != "" {
				result += " AS " + managedQuote(a[3])
			}
			projections = append(projections, result)
			continue
		}
		p := managedProjection.FindStringSubmatch(column)
		if p == nil {
			return "", errManagedQuery
		}
		result := managedQuote(p[1])
		if p[2] != "" {
			result += " AS " + managedQuote(p[2])
		}
		projections = append(projections, result)
	}
	result := "SELECT " + strings.Join(projections, ", ") + ` FROM "public"."` + table + `"`
	if m[4] != "" {
		where, err := managedWhere(m[4])
		if err != nil {
			return "", err
		}
		result += " WHERE " + where
	}
	if m[5] != "" {
		columns := strings.Split(m[5], ",")
		if len(columns) > 16 {
			return "", errManagedQuery
		}
		order := make([]string, 0, len(columns))
		for _, column := range columns {
			o := managedOrder.FindStringSubmatch(strings.TrimSpace(column))
			if o == nil {
				return "", errManagedQuery
			}
			value := managedQuote(o[1])
			if o[2] != "" {
				value += " " + strings.ToUpper(o[2])
			}
			order = append(order, value)
		}
		result += " ORDER BY " + strings.Join(order, ", ")
	}
	if m[6] != "" {
		limit, err := strconv.Atoi(m[6])
		if err != nil || limit < 1 || limit > 1000 {
			return "", errManagedQuery
		}
		result += " LIMIT " + strconv.Itoa(limit)
	}
	return result, nil
}

func managedName(identifier string) string {
	if strings.HasPrefix(identifier, `"`) {
		return strings.Trim(identifier, `"`)
	}
	return strings.ToLower(identifier)
}
func managedQuote(identifier string) string { return `"` + managedName(identifier) + `"` }

func managedWhere(input string) (string, error) {
	var out strings.Builder
	for count := 0; count < 16; count++ {
		m := managedCondition.FindStringSubmatchIndex(input)
		if m == nil {
			return "", errManagedQuery
		}
		part := func(n int) string { return input[m[n*2]:m[n*2+1]] }
		operator := strings.ToUpper(strings.Join(strings.Fields(part(2)), " "))
		value := part(3)
		if strings.HasPrefix(operator, "IS") && value != "NULL" && value != "TRUE" && value != "FALSE" && !strings.EqualFold(value, "null") && !strings.EqualFold(value, "true") && !strings.EqualFold(value, "false") {
			return "", errManagedQuery
		}
		out.WriteString(managedQuote(part(1)) + " " + operator + " " + value)
		input = input[m[1]:]
		if strings.TrimSpace(input) == "" {
			return out.String(), nil
		}
		conjunction := managedConjunction.FindStringSubmatchIndex(input)
		if conjunction == nil {
			return "", errManagedQuery
		}
		out.WriteString(" " + strings.ToUpper(input[conjunction[2]:conjunction[3]]) + " ")
		input = input[conjunction[1]:]
	}
	return "", errManagedQuery
}
