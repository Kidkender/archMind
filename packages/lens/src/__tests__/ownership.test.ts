import type { GoFile } from "../callgraph.js"
import { findUnscopedAccess } from "../ownership.js"

const f = (path: string, content: string): GoFile => ({ path, content })
const flagged = (files: GoFile[]) => findUnscopedAccess(files).map((x) => x.function)

const PRELUDE = `package s
type DB struct{}
func (d *DB) Create(v any) *DB { return d }
func (d *DB) Update(c string, v any) *DB { return d }
func (d *DB) Where(q string, args ...any) *DB { return d }
func (d *DB) First(out any, args ...any) *DB { return d }
func (d *DB) Delete(out any) *DB { return d }
type Invite struct{ ID uint; CharacterID uint; GuildID uint }
type Member struct{ CharacterID uint; GuildID uint; Role string }
type S struct{ db *DB }
`

describe("findUnscopedAccess", () => {
  it("reports a function that loads a resource by id and never relates it to the caller", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  s.db.First(&inv, inviteID)
  return s.db.Delete(&inv).Error
}`)])).toEqual(["S.Decline"])
  })

  it("accepts a comparison between a field of the loaded resource and the caller", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  s.db.First(&inv, inviteID)
  if inv.CharacterID != characterID { return nil }
  return s.db.Delete(&inv).Error
}`)])).toEqual([])
  })

  it("accepts one query that scopes the resource id by the caller", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  s.db.Where("id = ? AND character_id = ?", inviteID, characterID).First(&inv)
  return s.db.Delete(&inv).Error
}`)])).toEqual([])
  })

  it("accepts a helper that is given both ids and relates them (membership loaded by caller, compared with the resource)", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func requireLeader(db *DB, characterID, guildID uint) error {
  var m Member
  db.Where("character_id = ?", characterID).First(&m)
  if m.GuildID != guildID || m.Role != "leader" { return nil }
  return nil
}
func (s *S) Invite(characterID, guildID, targetID uint) error {
  if err := requireLeader(s.db, characterID, guildID); err != nil { return err }
  return nil
}`)])).toEqual([])
  })

  it("reports the same function once the helper call is removed", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func requireLeader(db *DB, characterID, guildID uint) error {
  var m Member
  db.Where("character_id = ?", characterID).First(&m)
  if m.GuildID != guildID || m.Role != "leader" { return nil }
  return nil
}
func (s *S) Invite(characterID, guildID, targetID uint) error {
  var m Member
  s.db.Where("character_id = ?", targetID).First(&m)
  return nil
}`)])).toEqual(["S.Invite"])
  })

  it("does not report self-service functions that take only the caller", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Mine(characterID uint) error {
  var m Member
  s.db.Where("character_id = ?", characterID).First(&m)
  return nil
}`)])).toEqual([])
  })

  it("does not report a helper's evidence when the caller id is not forwarded to it", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func requireLeader(db *DB, characterID, guildID uint) error {
  var m Member
  db.Where("character_id = ?", characterID).First(&m)
  if m.GuildID != guildID { return nil }
  return nil
}
func (s *S) Invite(characterID, guildID uint) error {
  return requireLeader(s.db, guildID, guildID)
}`)])).toEqual(["S.Invite"])
  })

  it("carries a tag through an assignment of a derived value", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  s.db.First(&inv, inviteID)
  owner := inv.CharacterID
  if owner != characterID { return nil }
  return nil
}`)])).toEqual([])
  })

  it("does not treat inserting a row that mentions both ids as a link", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Invite(characterID, guildID uint) error {
  return s.db.Create(&Invite{GuildID: guildID, CharacterID: characterID}).Error
}`)])).toEqual(["S.Invite"])
  })

  it("does not let a reused error variable carry both sides into an `err != nil` check", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  if err := s.db.First(&inv, inviteID).Error; err != nil { return err }
  ok, err := isMember(s.db, characterID)
  if err != nil { return err }
  _ = ok
  return s.db.Delete(&inv).Error
}`)])).toEqual(["S.Decline"])
  })

  it("does not treat a comparison with nil as relating the two ids", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  err := audit(characterID, inviteID)
  if err != nil { return err }
  return nil
}`)])).toEqual(["S.Decline"])
  })

  it("still accepts a comparison of two derived values after variables are reassigned", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Decline(characterID, inviteID uint) error {
  var inv Invite
  s.db.First(&inv, inviteID)
  owner := inv.CharacterID
  who := characterID
  if owner != who { return nil }
  return nil
}`)])).toEqual([])
  })

  it("does not treat writing the caller into the resource's row as a link", () => {
    expect(flagged([f("s/s.go", PRELUDE + `func (s *S) Claim(characterID, guildID uint) error {
  return s.db.Where("id = ?", guildID).Update("leader_id", characterID).Error
}`)])).toEqual(["S.Claim"])
  })
})
