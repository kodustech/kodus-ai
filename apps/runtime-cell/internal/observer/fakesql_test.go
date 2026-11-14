package observer

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"sync"
)

// A database/sql driver that records what the observer asks for.
type fakeDB struct {
	mu       sync.Mutex
	readOnly []bool
	queries  []string
}

type fakeConn struct{ db *fakeDB }
type fakeTx struct{}
type fakeRows struct {
	cols []string
	data [][]driver.Value
	i    int
}

func (d *fakeDB) Open(string) (driver.Conn, error) { return &fakeConn{d}, nil }
func (c *fakeConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (c *fakeConn) Close() error              { return nil }
func (c *fakeConn) Begin() (driver.Tx, error) { return fakeTx{}, nil }
func (c *fakeConn) BeginTx(_ context.Context, o driver.TxOptions) (driver.Tx, error) {
	c.db.mu.Lock()
	c.db.readOnly = append(c.db.readOnly, o.ReadOnly)
	c.db.mu.Unlock()
	return fakeTx{}, nil
}
func (c *fakeConn) ExecContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Result, error) {
	c.db.mu.Lock()
	c.db.queries = append(c.db.queries, q)
	c.db.mu.Unlock()
	return driver.RowsAffected(0), nil
}
func (c *fakeConn) QueryContext(_ context.Context, q string, _ []driver.NamedValue) (driver.Rows, error) {
	c.db.mu.Lock()
	c.db.queries = append(c.db.queries, q)
	c.db.mu.Unlock()
	return &fakeRows{cols: []string{"id", "email"}, data: [][]driver.Value{{int64(1), []byte("a@x")}, {int64(2), nil}}}, nil
}
func (fakeTx) Commit() error          { return errors.New("observer never commits") }
func (fakeTx) Rollback() error        { return nil }
func (r *fakeRows) Columns() []string { return r.cols }
func (r *fakeRows) Close() error      { return nil }
func (r *fakeRows) Next(dest []driver.Value) error {
	if r.i >= len(r.data) {
		return io.EOF
	}
	copy(dest, r.data[r.i])
	r.i++
	return nil
}

var registerOnce sync.Once
var shared = &fakeDB{}

func openFake(Target) (*sql.DB, error) {
	registerOnce.Do(func() { sql.Register("observer-fake", shared) })
	return sql.Open("observer-fake", "")
}
