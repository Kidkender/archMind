import { buildCallGraph, type GoFile } from "../callgraph.js"
import { findTransactionEffects } from "../effects.js"

const f = (path: string, content: string): GoFile => ({ path, content })

const FX = `package s
import "sync"
type Fx struct{ mu sync.Mutex; by map[string]int }
func (f *Fx) Mark(k string) { f.mu.Lock(); defer f.mu.Unlock(); f.by[k] = 1 }
func (f *Fx) Marked(k string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.by[k] > 0 }
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
`
const found = (files: GoFile[]) => findTransactionEffects(buildCallGraph(files)).map((x) => `${x.function} -> ${x.callee}`)

describe("transactions a function opens", () => {
  it("marks a function whose body calls .Transaction", () => {
    const g = buildCallGraph([f("s/s.go", FX + `type S struct{ db *DB }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { return nil }) }
func (s *S) Other() {}
`)])
    expect(g.findDefs("S.Run")[0].opensTransaction).toBe(true)
    expect(g.findDefs("S.Other")[0].opensTransaction).toBe(false)
  })
})

describe("findTransactionEffects", () => {
  it("reports a state-changing call on a lock-guarded object made inside a Transaction closure", () => {
    expect(found([f("s/s.go", FX + `type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.fx.Mark("a"); return nil }) }
`)])).toEqual(["S.Run -> Fx.Mark"])
  })

  it("does not report a read-only call on the same object", () => {
    expect(found([f("s/s.go", FX + `type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { _ = s.fx.Marked("a"); return nil }) }
`)])).toEqual([])
  })

  it("does not report a call made after the transaction returned", () => {
    expect(found([f("s/s.go", FX + `type S struct{ db *DB; fx *Fx }
func (s *S) Run() error {
	err := s.db.Transaction(func(tx *DB) error { return nil })
	s.fx.Mark("a")
	return err
}
`)])).toEqual([])
  })

  it("does not report when the function undoes the effects if the transaction fails", () => {
    expect(found([f("s/s.go", FX + `type Journal struct{}
func (j *Journal) Rollback() {}
type S struct{ db *DB; fx *Fx }
func (s *S) Run() error {
	j := &Journal{}
	err := s.db.Transaction(func(tx *DB) error { s.fx.Mark("a"); return nil })
	if err != nil { j.Rollback() }
	return err
}
`)])).toEqual([])
  })

  it("follows a helper called from the closure and names the function that opened the transaction", () => {
    expect(found([f("s/s.go", FX + `type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { return s.apply(tx) }) }
func (s *S) apply(tx *DB) error { s.fx.Mark("a"); return nil }
`)])).toEqual(["S.Run -> Fx.Mark"])
  })

  it("does not report an object that is not guarded by a lock (a per-call object)", () => {
    expect(found([f("s/s.go", `package s
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type Swing struct{ hits int }
func (w *Swing) Hit() { w.hits++ }
type S struct{ db *DB }
func (s *S) Run() error { w := &Swing{}; return s.db.Transaction(func(tx *DB) error { w.Hit(); return nil }) }
`)])).toEqual([])
  })

  it("does not report a method that takes the transaction handle itself", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type Store struct{ mu sync.Mutex; rows map[int]int }
func (st *Store) Put(tx *DB, k int) { st.mu.Lock(); st.rows[k] = 1; st.mu.Unlock() }
type S struct{ db *DB; st *Store }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.st.Put(tx, 1); return nil }) }
`)])).toEqual([])
  })

  it("recognises an embedded sync.Mutex", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type Book struct{ sync.Mutex; n map[string]int }
func (b *Book) Set(k string) { b.Lock(); b.n[k] = 1; b.Unlock() }
type S struct{ db *DB; bk *Book }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.bk.Set("a"); return nil }) }
`)])).toEqual(["S.Run -> Book.Set"])
  })

  it("reports the line of the call inside the closure", () => {
    const [finding] = findTransactionEffects(buildCallGraph([f("s/s.go", FX + `type S struct{ db *DB; fx *Fx }
func (s *S) Run() error {
	return s.db.Transaction(func(tx *DB) error {
		s.fx.Mark("a")
		return nil
	})
}
`)]))
    expect(finding).toMatchObject({ file: "s/s.go", function: "S.Run", callee: "Fx.Mark" })
    expect(finding.line).toBeGreaterThan(0)
  })

  it("reports the entry point into a lock-guarded object once, not its internal helpers", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type Fx struct{ mu sync.Mutex; by map[string]int }
func (f *Fx) Mark(k string) { f.mu.Lock(); f.by[k] = 1; f.touch(k); f.mu.Unlock() }
func (f *Fx) touch(k string) { f.by[k+"!"] = 1 }
type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.fx.Mark("a"); return nil }) }
`)])).toEqual(["S.Run -> Fx.Mark"])
  })

  it("does not count writes to a local map as changing the object's state", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type Hub struct{ mu sync.Mutex; rooms map[string][]int }
func (h *Hub) PlayersIn(z string) []int {
	h.mu.Lock(); defer h.mu.Unlock()
	seen := map[int]bool{}
	var out []int
	for _, id := range h.rooms[z] { if seen[id] { continue }; seen[id] = true; out = append(out, id) }
	return out
}
type S struct{ db *DB; hub *Hub }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { _ = s.hub.PlayersIn("a"); return nil }) }
`)])).toEqual([])
  })

  it("counts a write made through a variable taken from the receiver's own state", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type State struct{ n int }
type Fx struct{ mu sync.Mutex; by map[string]*State }
func (f *Fx) stateOf(k string) *State { return f.by[k] }
func (f *Fx) Slow(k string) { f.mu.Lock(); st := f.stateOf(k); st.n = 5; f.mu.Unlock() }
type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.fx.Slow("a"); return nil }) }
`)])).toEqual(["S.Run -> Fx.Slow"])
  })

  it("counts a write made through a field of a call on the receiver, as in f.stateOf(k).n = 5", () => {
    expect(found([f("s/s.go", `package s
import "sync"
type DB struct{}
func (d *DB) Transaction(fn func(tx *DB) error) error { return fn(d) }
type State struct{ n int }
type Fx struct{ mu sync.Mutex; by map[string]*State }
func (f *Fx) stateOf(k string) *State { return f.by[k] }
func (f *Fx) Slow(k string) { f.mu.Lock(); defer f.mu.Unlock(); f.stateOf(k).n = 5 }
type S struct{ db *DB; fx *Fx }
func (s *S) Run() error { return s.db.Transaction(func(tx *DB) error { s.fx.Slow("a"); return nil }) }
`)])).toEqual(["S.Run -> Fx.Slow"])
  })
})

