package awsec2

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

type statement struct {
	Sid       string
	Effect    string
	Action    any
	Condition map[string]map[string]any
}

func load(t *testing.T, name string) []statement {
	t.Helper()
	raw, err := os.ReadFile("iam/" + name)
	if err != nil {
		t.Fatal(err)
	}
	var doc struct{ Statement []statement }
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc.Statement
}

func actions(s statement) []string {
	switch a := s.Action.(type) {
	case string:
		return []string{a}
	case []any:
		var out []string
		for _, x := range a {
			out = append(out, x.(string))
		}
		return out
	}
	return nil
}

// S-07 (static part): the simulator run belongs to CI with a test account;
// here we pin the statements the design depends on.
func TestCellRolePolicy(t *testing.T) {
	st := load(t, "cell-role.json")
	var hardDeny, passRoleDeny, runNeedsTemplate bool
	for _, s := range st {
		acts := strings.Join(actions(s), ",")
		if s.Effect == "Allow" && strings.Contains(acts, "iam:PassRole") {
			t.Fatal("cell role allows iam:PassRole")
		}
		if s.Effect == "Deny" && strings.Contains(acts, "ec2:CreateTags") && strings.Contains(acts, "ec2:DeleteTags") {
			if keys, ok := s.Condition["ForAnyValue:StringEquals"]["aws:TagKeys"]; ok && strings.Contains(toJSON(keys), "kodus:hard-expires") {
				hardDeny = true
			}
		}
		if s.Effect == "Deny" && strings.Contains(acts, "iam:PassRole") {
			passRoleDeny = true
		}
		if s.Effect == "Allow" && acts == "ec2:RunInstances" {
			if _, ok := s.Condition["ArnEquals"]["ec2:LaunchTemplate"]; ok {
				runNeedsTemplate = true
			}
		}
	}
	if !hardDeny || !passRoleDeny || !runNeedsTemplate {
		t.Fatalf("hardDeny=%v passRoleDeny=%v runNeedsTemplate=%v", hardDeny, passRoleDeny, runNeedsTemplate)
	}
}

func TestReaperRoleOnlyDescribesAndTerminates(t *testing.T) {
	for _, s := range load(t, "reaper-role.json") {
		for _, a := range actions(s) {
			if a != "ec2:DescribeInstances" && a != "ec2:TerminateInstances" {
				t.Fatalf("reaper role has %s", a)
			}
			if a == "ec2:TerminateInstances" && s.Condition["StringEquals"]["ec2:ResourceTag/kodus:cell"] == nil {
				t.Fatal("terminate not conditioned on the cell tag")
			}
		}
	}
}

func toJSON(v any) string { b, _ := json.Marshal(v); return string(b) }

// StringEqualsIfExists on the cell tag let the role launch into, and open
// rules on, every untagged security group of the account (the VPC's default
// group, other products' groups). Every security-group grant must require
// the cell's tag.
func TestCellRoleTouchesOnlyThisCellsSecurityGroups(t *testing.T) {
	raw, err := os.ReadFile("iam/cell-role.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Statement []struct {
			Sid       string
			Effect    string
			Action    any
			Resource  any
			Condition map[string]map[string]any
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, s := range doc.Statement {
		if s.Effect != "Allow" || !strings.Contains(toJSON(s.Resource), "security-group") {
			continue
		}
		for op := range s.Condition {
			if strings.HasSuffix(op, "IfExists") {
				t.Errorf("%s: %s on a security-group grant", s.Sid, op)
			}
		}
		eq := s.Condition["StringEquals"]
		if eq["aws:ResourceTag/kodus:cell"] == nil && eq["aws:RequestTag/kodus:cell"] == nil {
			t.Errorf("%s: a security-group grant without the cell tag", s.Sid)
		}
	}
}

// Root provenance used to have no immutable first-write rule. A replacement
// changes the live root id, so allowing this tag to move breaks later rounds.
func TestCellRoleCapturesOriginalRootOnceAndCanObserveReset(t *testing.T) {
	st := load(t, "cell-role.json")
	var firstWrite, overwriteDeny, deleteDeny, launchDeny, describeTask, createTask bool
	for _, s := range st {
		acts := strings.Join(actions(s), ",")
		keys := toJSON(s.Condition["ForAnyValue:StringEquals"]["aws:TagKeys"])
		switch s.Sid {
		case "RecordOriginalRootOnce":
			firstWrite = s.Effect == "Allow" && acts == "ec2:CreateTags" && s.Condition["Null"]["aws:ResourceTag/"+tagOriginalRootVolume] == "true" && s.Condition["StringEquals"]["aws:ResourceTag/kodus:cell"] == "${CellId}" && strings.Contains(toJSON(s.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]), tagOriginalRootVolume)
		case "OriginalRootCannotBeOverwritten":
			overwriteDeny = s.Effect == "Deny" && acts == "ec2:CreateTags" && s.Condition["Null"]["aws:ResourceTag/"+tagOriginalRootVolume] == "false" && strings.Contains(keys, tagOriginalRootVolume)
		case "OriginalRootCannotBeDeleted":
			deleteDeny = s.Effect == "Deny" && acts == "ec2:DeleteTags" && strings.Contains(keys, tagOriginalRootVolume)
		case "OriginalRootCannotBeSuppliedAtLaunch":
			launchDeny = s.Effect == "Deny" && acts == "ec2:CreateTags" && s.Condition["StringEquals"]["ec2:CreateAction"] == "RunInstances" && strings.Contains(keys, tagOriginalRootVolume)
		case "Describe":
			describeTask = strings.Contains(acts, "ec2:DescribeReplaceRootVolumeTasks")
		case "CreateTaggedRootReplacementTask":
			createTask = s.Effect == "Allow" && acts == "ec2:CreateReplaceRootVolumeTask" && s.Condition["StringEquals"]["aws:RequestTag/kodus:cell"] == "${CellId}"
		}
	}
	if !firstWrite || !overwriteDeny || !deleteDeny || !launchDeny || !describeTask || !createTask {
		t.Fatalf("firstWrite=%v overwriteDeny=%v deleteDeny=%v launchDeny=%v describeTask=%v createTask=%v", firstWrite, overwriteDeny, deleteDeny, launchDeny, describeTask, createTask)
	}
}
